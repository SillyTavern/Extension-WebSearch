import { appendMediaToMessage, callPopup, extension_prompt_types, getRequestHeaders, saveSettingsDebounced, setExtensionPrompt, substituteParams } from '../../../../script.js';
import { appendFileContent, uploadFileAttachment } from '../../../chats.js';
import { doExtrasFetch, extension_settings, getApiUrl, getContext, modules, renderExtensionTemplate } from '../../../extensions.js';
import { registerDebugFunction } from '../../../power-user.js';
import { SECRET_KEYS, secret_state, writeSecret } from '../../../secrets.js';
import { registerSlashCommand } from '../../../slash-commands.js';
import { extractTextFromHTML, isFalseBoolean, isTrueBoolean, onlyUnique, trimToEndSentence, trimToStartSentence } from '../../../utils.js';

const storage = new localforage.createInstance({ name: 'SillyTavern_WebSearch' });
const extensionPromptMarker = '___WebSearch___';

const WEBSEARCH_SOURCES = {
    SERPAPI: 'serpapi',
    EXTRAS: 'extras',
};

const defaultSettings = {
    triggerPhrases: [
        'search for',
        'look up',
        'find me',
        'tell me',
        'explain me',
        'can you',
        'how to',
        'how is',
        'how do you',
        'ways to',
        'who is',
        'who are',
        'who was',
        'who were',
        'who did',
        'what is',
        'what\'s',
        'what are',
        'what\'re',
        'what was',
        'what were',
        'what did',
        'what do',
        'where are',
        'where\'re',
        'where\'s',
        'where is',
        'where was',
        'where were',
        'where did',
        'where do',
        'where does',
        'where can',
        'how do i',
        'where do i',
        'how much',
        'definition of',
        'what happened',
        'why does',
        'why do',
        'why did',
        'why is',
        'why are',
        'why were',
        'when does',
        'when do',
        'when did',
        'when is',
        'when was',
        'when were',
        'how does',
        'meaning of',
    ],
    insertionTemplate: '***\nRelevant information from the web ({{query}}):\n{{text}}\n***',
    cacheLifetime: 60 * 60 * 24 * 7, // 1 week
    position: extension_prompt_types.IN_PROMPT,
    depth: 2,
    maxWords: 10,
    budget: 1500,
    source: WEBSEARCH_SOURCES.SERPAPI,
    extras_engine: 'google',
    visit_enabled: false,
    visit_count: 3,
    visit_file_header: 'Web search results for "{{query}}"\n\n',
    visit_block_header: '---\nInformation from {{link}}\n\n{{text}}\n\n',
    visit_blacklist: [
        'youtube.com',
        'twitter.com',
        'facebook.com',
        'instagram.com',
    ],
    use_backticks: true,
    use_trigger_phrases: true,
};

async function onWebSearchPrompt(chat) {
    if (!extension_settings.websearch.enabled) {
        console.debug('WebSearch: extension is disabled');
        return;
    }

    if (!chat || !Array.isArray(chat) || chat.length === 0) {
        console.debug('WebSearch: chat is empty');
        return;
    }

    const startTime = Date.now();

    try {
        console.debug('WebSearch: resetting the extension prompt');
        setExtensionPrompt(extensionPromptMarker, '', extension_settings.websearch.position, extension_settings.websearch.depth);

        if (extension_settings.websearch.source === WEBSEARCH_SOURCES.SERPAPI && !secret_state[SECRET_KEYS.SERPAPI]) {
            console.debug('WebSearch: no SerpApi key found');
            return;
        }

        if (extension_settings.websearch.source === WEBSEARCH_SOURCES.EXTRAS && !modules.includes('websearch')) {
            console.debug('WebSearch: no websearch Extras module');
            return;
        }

        // Find the latest user message
        let searchQuery = '';
        let triggerMessage = null;

        for (let message of chat.slice().reverse()) {
            if (message.is_system) {
                continue;
            }

            if (message.mes && message.is_user) {
                if (isBreakCondition(message.mes)) {
                    break;
                }

                const query = extractSearchQuery(message.mes);

                if (!query) {
                    continue;
                }

                searchQuery = query;
                triggerMessage = message;
                break;
            }
        }

        if (!searchQuery) {
            console.debug('WebSearch: no user message found');
            return;
        }

        const { text, links } = await performSearchRequest(searchQuery, { useCache: true });

        if (!text) {
            console.debug('WebSearch: search failed');
            return;
        }

        if (extension_settings.websearch.visit_enabled && triggerMessage && Array.isArray(links) && links.length > 0) {
            const messageId = Number(triggerMessage.index);
            const visitResult = await visitLinksAndAttachToMessage(searchQuery, links, messageId);

            if (visitResult && visitResult.file) {
                triggerMessage.extra = Object.assign((triggerMessage.extra || {}), { file: visitResult.file });
                triggerMessage.mes = await appendFileContent(triggerMessage, triggerMessage.mes);
            }
        }

        // Insert the result into the prompt
        let template = extension_settings.websearch.insertionTemplate;

        if (!template) {
            console.debug('WebSearch: no insertion template found, using default');
            template = defaultSettings.insertionTemplate;
        }

        if (!(/{{text}}/i.test(template))) {
            console.debug('WebSearch: insertion template does not contain {{text}} macro, appending');
            template += '\n{{text}}';
        }

        const extensionPrompt = substituteParams(template.replace(/{{text}}/i, text).replace(/{{query}}/i, searchQuery));
        setExtensionPrompt(extensionPromptMarker, extensionPrompt, extension_settings.websearch.position, extension_settings.websearch.depth);
        console.log('WebSearch: prompt updated', extensionPrompt);
    } catch (error) {
        console.error('WebSearch: error while processing the request', error);
    } finally {
        console.log('WebSearch: finished in', Date.now() - startTime, 'ms');
    }
}

function isBreakCondition(message) {
    if (message && message.trim().startsWith('!')) {
        console.debug('WebSearch: message starts with an exclamation mark, stopping');
        return true;
    }

    return false;
}

/**
 * Extracts the search query from the message.
 * @param {string} message Message to extract the search query from
 * @returns {string} Search query
 */
function extractSearchQuery(message) {
    if (message && message.trim().startsWith('.')) {
        console.debug('WebSearch: message starts with a dot, ignoring');
        return;
    }

    message = processInputText(message);

    if (!message) {
        console.debug('WebSearch: processed message is empty');
        return;
    }

    console.log('WebSearch: processed message', message);

    if (extension_settings.websearch.use_backticks) {
        // Remove triple backtick blocks
        message = message.replace(/```[^`]+```/gi, '');
        // Find the first backtick-enclosed substring
        const match = message.match(/`([^`]+)`/i);

        if (match) {
            const query = match[1].trim();
            console.debug('WebSearch: backtick-enclosed substring found', query);
            return query;
        }
    }

    if (extension_settings.websearch.use_trigger_phrases) {
        // Find the first index of the trigger phrase in the message
        let triggerPhraseIndex = -1;
        let triggerPhraseActual = '';
        const triggerPhrases = extension_settings.websearch.triggerPhrases;

        for (let i = 0; i < triggerPhrases.length; i++) {
            const triggerPhrase = triggerPhrases[i].toLowerCase();
            const indexOf = message.indexOf(triggerPhrase);

            if (indexOf !== -1) {
                console.debug(`WebSearch: trigger phrase found "${triggerPhrase}" at index ${indexOf}`);
                triggerPhraseIndex = indexOf;
                triggerPhraseActual = triggerPhrase;
                break;
            }
        }

        if (triggerPhraseIndex === -1) {
            console.debug('WebSearch: no trigger phrase found');
            return;
        }

        // Extract the relevant part of the message (after the trigger phrase)
        message = message.substring(triggerPhraseIndex + triggerPhraseActual.length).trim();
        console.log('WebSearch: extracted query', message);

        // Limit the number of words
        const maxWords = extension_settings.websearch.maxWords;
        message = message.split(' ').slice(0, maxWords).join(' ');
        console.log('WebSearch: query after word limit', message);

        return message;
    }
}

/**
 * Pre-process search query input text.
 * @param {string} text Input text
 * @returns {string} Processed text
 */
function processInputText(text) {
    // Convert to lowercase
    text = text.toLowerCase();
    // Remove punctuation
    text = text.replace(/[\\.,@#!?$%&;:{}=_~[\]]/g, '');
    // Remove double quotes (including region-specific ones)
    text = text.replace(/["“”]/g, '');
    // Remove carriage returns
    text = text.replace(/\r/g, '');
    // Replace newlines with spaces
    text = text.replace(/[\n]+/g, ' ');
    // Collapse multiple spaces into one
    text = text.replace(/\s+/g, ' ');
    // Trim
    text = text.trim();

    return text;
}

/**
 * Checks if the provided link is allowed to be visited or blacklisted.
 * @param {string} link Link to check
 * @returns {boolean} Whether the link is allowed
 */
function isAllowedUrl(link) {
    try {
        const url = new URL(link);
        const isBlacklisted = extension_settings.websearch.visit_blacklist.some(y => url.hostname.includes(y));
        if (isBlacklisted) {
            console.debug('WebSearch: blacklisted link', link);
        }
        return !isBlacklisted;
    } catch (error) {
        console.debug('WebSearch: invalid link', link);
        return false;
    }
}

/**
 * Visits the provided web links and extracts the text from the resulting HTML.
 * @param {string} query Search query
 * @param {string[]} links Array of links to visit
 * @returns {Promise<string>} Extracted text
 */
async function visitLinks(query, links) {
    if (!Array.isArray(links)) {
        console.debug('WebSearch: not an array of links');
        return '';
    }

    links = links.filter(isAllowedUrl);

    if (links.length === 0) {
        console.debug('WebSearch: no links to visit');
        return '';
    }

    const visitCount = extension_settings.websearch.visit_count;
    const visitPromises = [];

    for (let i = 0; i < Math.min(visitCount, links.length); i++) {
        const link = links[i];
        visitPromises.push(visitLink(link));
    }

    const visitResult = await Promise.allSettled(visitPromises);

    let linkResult = '';

    for (let result of visitResult) {
        if (result.status === 'fulfilled' && result.value) {
            const { link, text } = result.value;

            if (text) {
                linkResult += substituteParams(extension_settings.websearch.visit_block_header.replace(/{{query}}/i, query).replace(/{{link}}/i, link).replace(/{{text}}/i, text));
            }
        }
    }

    if (!linkResult) {
        console.debug('WebSearch: no text to attach');
        return '';
    }

    const fileHeader = substituteParams(extension_settings.websearch.visit_file_header.replace(/{{query}}/i, query));
    const fileText = fileHeader + linkResult;
    return fileText;
}

/**
 * Visits the provided web links and attaches the resulting text to the chat as a file.
 * @param {string} query Search query
 * @param {string[]} links Web links to visit
 * @param {number} messageId Message ID that triggered the search
 * @returns {Promise<{fileContent: string, file: object}>} File content and file object
 */
async function visitLinksAndAttachToMessage(query, links, messageId) {
    if (isNaN(messageId)) {
        console.debug('WebSearch: invalid message ID');
        return;
    }

    const context = getContext();
    const message = context.chat[messageId];

    if (!message) {
        console.debug('WebSearch: failed to find the message');
        return;
    }

    if (message?.extra?.file) {
        console.debug('WebSearch: message already has a file attachment');
        return;
    }

    if (!message.extra) {
        message.extra = {};
    }

    try {
        const fileText = await visitLinks(query, links);

        if (!fileText) {
            return;
        }

        const fileName = `websearch_${sluggify(query)}_${Date.now()}.txt`;
        const base64Data = window.btoa(unescape(encodeURIComponent(fileText)));
        const fileUrl = await uploadFileAttachment(fileName, base64Data);

        if (!fileUrl) {
            console.debug('WebSearch: failed to upload the file');
            return;
        }

        message.extra.file = {
            url: fileUrl,
            size: fileText.length,
            name: fileName,
        };

        const messageElement = $(`.mes[mesid="${messageId}"]`);

        if (messageElement.length === 0) {
            console.debug('WebSearch: failed to find the message element');
            return;
        }

        appendMediaToMessage(message, messageElement);
        return { fileContent: fileText, file: message.extra.file };
    } catch (error) {
        console.error('WebSearch: failed to attach the file', error);
    }
}

function sluggify(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 32);
}

/**
 * Visits the provided web link and extracts the text from the resulting HTML.
 * @param {string} link Web link to visit
 * @returns {Promise<{link: string, text:string}>} Extracted text
 */
async function visitLink(link) {
    try {
        const result = await fetch('/api/serpapi/visit', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ url: link }),
        });

        if (!result.ok) {
            console.debug(`WebSearch: visit request failed with status ${result.statusText}`, link);
            return;
        }

        const data = await result.blob();
        const text = await extractTextFromHTML(data, 'p'); // Only extract text from <p> tags
        console.debug('WebSearch: visit result', link, text);
        return { link, text };
    } catch (error) {
        console.error('WebSearch: visit failed', error);
    }
}

/**
 * Performs a search query via SerpApi.
 * @param {string} query Search query
 * @returns {Promise<{textBits: string[], links: string[]}>} Lines of search results.
 */
async function doSerpApiQuery(query) {
    // Perform the search
    const result = await fetch('/api/serpapi/search', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ query }),
    });

    if (!result.ok) {
        const text = await result.text();
        console.debug('WebSearch: search request failed', result.statusText, text);
        return;
    }

    const data = await result.json();
    console.debug('WebSearch: search response', data);

    // Extract the relevant information
    // Order: 1. Answer Box, 2. Knowledge Graph, 3. Organic Results (max 5), 4. Related Questions (max 5)
    let textBits = [];
    let links = [];

    if (Array.isArray(data.organic_results)) {
        links.push(...data.organic_results.map(x => x.link).filter(x => x));
    }

    if (data.answer_box) {
        switch (data.answer_box.type) {
            case 'organic_result':
                textBits.push(data.answer_box.snippet || data.answer_box.result || data.answer_box.title);

                if (data.answer_box.list) {
                    textBits.push(data.answer_box.list.join('\n'));
                }

                if (data.answer_box.table) {
                    textBits.push(data.answer_box.table.join('\n'));
                }

                break;
            case 'translation_result':
                textBits.push(data.answer_box.translation?.target?.text);
                break;
            case 'calculator_result':
                textBits.push(`Answer: ${data.answer_box.result}`);
                break;
            case 'population_result':
                textBits.push(`${data.answer_box.place} ${data.answer_box.population}`);
                break;
            case 'currency_converter':
                textBits.push(data.answer_box.result);
                break;
            case 'finance_results':
                textBits.push(`${data.answer_box.title} ${data.answer_box.exchange} ${data.answer_box.stock} ${data.answer_box.price} ${data.answer_box.currency}`);
                break;
            case 'weather_result':
                textBits.push(`${data.answer_box.location}; ${data.answer_box.weather}; ${data.answer_box.temperature} ${data.answer_box.unit}`);
                break;
            case 'flight_duration':
                textBits.push(data.answer_box.duration);
                break;
            case 'dictionary_results':
                textBits.push(data.answer_box.definitions?.join('\n'));
                break;
            case 'time':
                textBits.push(`${data.answer_box.result} ${data.answer_box.date}`);
                break;
            default:
                textBits.push(data.answer_box.result || data.answer_box.answer || data.answer_box.title);
                break;
        }
    }

    if (data.knowledge_graph) {
        textBits.push(data.knowledge_graph.description || data.knowledge_graph.snippet || data.knowledge_graph.merchant_description || data.knowledge_graph.title);
    }

    const MAX_RESULTS = 10;

    for (let i = 0; i < MAX_RESULTS; i++) {
        if (Array.isArray(data.organic_results)) {
            const result = data.organic_results[i];
            if (result) {
                textBits.push(result.snippet);
            }
        }

        if (Array.isArray(data.related_questions)) {
            const result = data.related_questions[i];
            if (result) {
                textBits.push(`${result.question} ${result.snippet}`);
            }
        }
    }

    return { textBits, links };
}

/**
 * Performs a search query via Extras API.
 * @param {string} query Search query
 * @returns {Promise<{textBits: string[], links: string[]}>} Lines of search results.
 */
async function doExtrasApiQuery(query) {
    const url = new URL(getApiUrl());
    url.pathname = '/api/websearch';
    const result = await doExtrasFetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Bypass-Tunnel-Reminder': 'bypass',
        },
        body: JSON.stringify({
            query: query,
            engine: extension_settings.websearch.extras_engine,
        }),
    });

    if (!result.ok) {
        const text = await result.text();
        console.debug('WebSearch: search request failed', result.statusText, text);
        return;
    }

    const data = await result.json();
    console.debug('WebSearch: search response', data);

    const textBits = data.results.split('\n');
    const links = Array.isArray(data.links) ? data.links : [];
    return { textBits, links };
}

/**
 *
 * @param {string} query Search query
 * @param {SearchRequestOptions} options Search request options
 * @typedef {{useCache?: boolean}} SearchRequestOptions
 * @returns {Promise<{text:string, links: string[]}>} Extracted text
 */
async function performSearchRequest(query, options = { useCache: true }) {
    // Check if the query is cached
    const cacheKey = `query_${query}`;
    const cacheLifetime = extension_settings.websearch.cacheLifetime;
    const cachedResult = await storage.getItem(cacheKey);

    if (options.useCache && cachedResult) {
        console.debug('WebSearch: cached result found', cachedResult);
        // Check if the cache is expired
        if (cachedResult.timestamp + cacheLifetime * 1000 < Date.now()) {
            console.debug('WebSearch: cached result is expired, requerying');
            await storage.removeItem(cacheKey);
        } else {
            console.debug('WebSearch: cached result is valid');
            return { text: cachedResult.text, links: cachedResult.links };
        }
    }

    /**
     * @returns {Promise<{textBits: string[], links: string[]}>}
     */
    async function callSearchSource() {
        try {
            switch (extension_settings.websearch.source) {
                case WEBSEARCH_SOURCES.SERPAPI:
                    return await doSerpApiQuery(query);
                case WEBSEARCH_SOURCES.EXTRAS:
                    return await doExtrasApiQuery(query);
                default:
                    throw new Error(`Unrecognized search source: ${extension_settings.websearch.source}`);
            }
        } catch (error) {
            console.error('WebSearch: search failed', error);
            return { textBits: [], links: [] };
        }
    }

    const { textBits, links } = await callSearchSource();
    const budget = extension_settings.websearch.budget;
    let text = '';

    for (let i of textBits.filter(onlyUnique)) {
        if (i) {
            // Incomplete sentences confuse the model, so we trim them
            if (i.endsWith('...')) {
                i = i.slice(0, -3);
                i = trimToEndSentence(i).trim();
            }

            if (i.startsWith('...')) {
                i = i.slice(3);
                i = trimToStartSentence(i).trim();
            }

            text += i + '\n';
        }
        if (text.length > budget) {
            break;
        }
    }

    if (!text) {
        console.debug('WebSearch: search produced no text');
        return { text: '', links: [] };
    }

    console.log(`WebSearch: extracted text (length = ${text.length}, budget = ${budget})`, text);

    // Save the result to cache
    if (options.useCache) {
        await storage.setItem(cacheKey, { text: text, links: links, timestamp: Date.now() });
    }

    return { text, links };
}

window['WebSearch_Intercept'] = onWebSearchPrompt;

jQuery(async () => {
    if (!extension_settings.websearch) {
        extension_settings.websearch = structuredClone(defaultSettings);
    }

    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings.websearch[key] === undefined) {
            extension_settings.websearch[key] = defaultSettings[key];
        }
    }

    const html = renderExtensionTemplate('third-party/Extension-WebSearch', 'settings');

    function switchSourceSettings() {
        $('#websearch_extras_settings').toggle(extension_settings.websearch.source === 'extras');
        $('#serpapi_settings').toggle(extension_settings.websearch.source === 'serpapi');
    }

    $('#extensions_settings2').append(html);
    $('#websearch_source').val(extension_settings.websearch.source);
    $('#websearch_source').on('change', () => {
        extension_settings.websearch.source = String($('#websearch_source').find(':selected').val());
        switchSourceSettings();
        saveSettingsDebounced();
    });
    $('#websearch_enabled').prop('checked', extension_settings.websearch.enabled);
    $('#websearch_enabled').on('change', () => {
        extension_settings.websearch.enabled = !!$('#websearch_enabled').prop('checked');
        setExtensionPrompt(extensionPromptMarker, '', extension_settings.websearch.position, extension_settings.websearch.depth);
        saveSettingsDebounced();
    });
    $('#websearch_extras_engine').val(extension_settings.websearch.extras_engine);
    $('#websearch_extras_engine').on('change', () => {
        extension_settings.websearch.extras_engine = String($('#websearch_extras_engine').find(':selected').val());
        saveSettingsDebounced();
    });
    $('#serpapi_key').toggleClass('success', !!secret_state[SECRET_KEYS.SERPAPI]);
    $('#serpapi_key').on('click', async () => {
        const key = await callPopup('<h3>Add a SerpApi key</h3>', 'input', '', { rows: 2 });

        if (key) {
            await writeSecret(SECRET_KEYS.SERPAPI, key.trim());
        }

        $('#serpapi_key').toggleClass('success', !!secret_state[SECRET_KEYS.SERPAPI]);
    });
    $('#websearch_budget').val(extension_settings.websearch.budget);
    $('#websearch_budget').on('input', () => {
        extension_settings.websearch.budget = Number($('#websearch_budget').val());
        saveSettingsDebounced();
    });
    $('#websearch_trigger_phrases').val(extension_settings.websearch.triggerPhrases.join('\n'));
    $('#websearch_trigger_phrases').on('input', () => {
        extension_settings.websearch.triggerPhrases = String($('#websearch_trigger_phrases').val()).split('\n');
        saveSettingsDebounced();
    });
    $('#websearch_cache_lifetime').val(extension_settings.websearch.cacheLifetime);
    $('#websearch_cache_lifetime').on('input', () => {
        extension_settings.websearch.cacheLifetime = Number($('#websearch_cache_lifetime').val());
        saveSettingsDebounced();
    });
    $('#websearch_max_words').val(extension_settings.websearch.maxWords);
    $('#websearch_max_words').on('input', () => {
        extension_settings.websearch.maxWords = Number($('#websearch_max_words').val());
        saveSettingsDebounced();
    });
    $('#websearch_template').val(extension_settings.websearch.insertionTemplate);
    $('#websearch_template').on('input', () => {
        extension_settings.websearch.insertionTemplate = String($('#websearch_template').val());
        saveSettingsDebounced();
    });
    $(`input[name="websearch_position"][value="${extension_settings.websearch.position}"]`).prop('checked', true);
    $('input[name="websearch_position"]').on('change', () => {
        extension_settings.websearch.position = Number($('input[name="websearch_position"]:checked').val());
        saveSettingsDebounced();
    });
    $('#websearch_depth').val(extension_settings.websearch.depth);
    $('#websearch_depth').on('input', () => {
        extension_settings.websearch.depth = Number($('#websearch_depth').val());
        saveSettingsDebounced();
    });
    $('#websearch_visit_enabled').prop('checked', extension_settings.websearch.visit_enabled);
    $('#websearch_visit_enabled').on('change', () => {
        extension_settings.websearch.visit_enabled = !!$('#websearch_visit_enabled').prop('checked');
        saveSettingsDebounced();
    });
    $('#websearch_visit_count').val(extension_settings.websearch.visit_count);
    $('#websearch_visit_count').on('input', () => {
        extension_settings.websearch.visit_count = Number($('#websearch_visit_count').val());
        saveSettingsDebounced();
    });
    $('#websearch_visit_blacklist').val(extension_settings.websearch.visit_blacklist.join('\n'));
    $('#websearch_visit_blacklist').on('input', () => {
        extension_settings.websearch.visit_blacklist = String($('#websearch_visit_blacklist').val()).split('\n');
        saveSettingsDebounced();
    });
    $('#websearch_file_header').val(extension_settings.websearch.visit_file_header);
    $('#websearch_file_header').on('input', () => {
        extension_settings.websearch.visit_file_header = String($('#websearch_file_header').val());
        saveSettingsDebounced();
    });
    $('#websearch_block_header').val(extension_settings.websearch.visit_block_header);
    $('#websearch_block_header').on('input', () => {
        extension_settings.websearch.visit_block_header = String($('#websearch_block_header').val());
        saveSettingsDebounced();
    });
    $('#websearch_use_backticks').prop('checked', extension_settings.websearch.use_backticks);
    $('#websearch_use_backticks').on('change', () => {
        extension_settings.websearch.use_backticks = !!$('#websearch_use_backticks').prop('checked');
        saveSettingsDebounced();
    });
    $('#websearch_use_trigger_phrases').prop('checked', extension_settings.websearch.use_trigger_phrases);
    $('#websearch_use_trigger_phrases').on('change', () => {
        extension_settings.websearch.use_trigger_phrases = !!$('#websearch_use_trigger_phrases').prop('checked');
        saveSettingsDebounced();
    });

    switchSourceSettings();

    registerDebugFunction('clearWebSearchCache', 'Clear the WebSearch cache', 'Removes all search results stored in the local cache.', async () => {
        await storage.clear();
        console.log('WebSearch: cache cleared');
        toastr.success('WebSearch: cache cleared');
    });

    registerDebugFunction('testWebSearch', 'Test the WebSearch extension', 'Performs a test search using the current settings.', async () => {
        try {
            const text = prompt('Enter a test message', 'How to make a sandwich');

            if (!text) {
                return;
            }

            const result = await performSearchRequest(text, { useCache: false });
            console.log('WebSearch: test result', text, result.text, result.links);
            alert(result.text);
        } catch (error) {
            toastr.error(String(error), 'WebSearch: test failed');
        }
    });

    registerSlashCommand('websearch', async (args, query) => {
        const includeSnippets = !isFalseBoolean(args.snippets);
        const includeLinks = isTrueBoolean(args.links);

        if (!query) {
            toastr.warning('No search query specified');
            return '';
        }

        if (!includeSnippets && !includeLinks) {
            toastr.warning('No search result type specified');
            return '';
        }

        const result = await performSearchRequest(query, { useCache: true });

        let output = includeSnippets ? result.text : '';

        if (includeLinks && Array.isArray(result.links) && result.links.length > 0) {
            const visitResult = await visitLinks(query, result.links);
            output += '\n' + visitResult;
        }

        return output;
    }, [], '<span class="monospace">(links=on|off snippets=on|off [query])</span> – performs a web search query. Use named arguments to specify what to return - page snippets (default: on) or full parsed pages (default: off) or both.', true, true);
});
