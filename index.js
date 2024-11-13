import { appendMediaToMessage, extension_prompt_types, getRequestHeaders, saveSettingsDebounced, setExtensionPrompt, substituteParamsExtended } from '../../../../script.js';
import { appendFileContent, uploadFileAttachment } from '../../../chats.js';
import { doExtrasFetch, extension_settings, getApiUrl, getContext, modules, renderExtensionTemplateAsync } from '../../../extensions.js';
import { registerDebugFunction } from '../../../power-user.js';
import { SECRET_KEYS, secret_state, writeSecret } from '../../../secrets.js';
import { POPUP_RESULT, POPUP_TYPE, callGenericPopup } from '../../../popup.js';
import { extractTextFromHTML, isFalseBoolean, isTrueBoolean, onlyUnique, trimToEndSentence, trimToStartSentence, getStringHash, regexFromString } from '../../../utils.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { commonEnumProviders } from '../../../slash-commands/SlashCommandCommonEnumsProvider.js';

const storage = new localforage.createInstance({ name: 'SillyTavern_WebSearch' });
const extensionPromptMarker = '___WebSearch___';

const WEBSEARCH_SOURCES = {
    SERPAPI: 'serpapi',
    EXTRAS: 'extras',
    PLUGIN: 'plugin',
    SEARXNG: 'searxng',
    TAVILY: 'tavily',
};

const VISIT_TARGETS = {
    MESSAGE: 0,
    DATA_BANK: 1,
};

/**
 * @typedef {Object} RegexRule
 * @property {string} pattern Regular expression pattern
 * @property {string} query Web search query
 */

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
    budget: 2000,
    source: WEBSEARCH_SOURCES.SERPAPI,
    extras_engine: 'google',
    visit_enabled: false,
    visit_target: VISIT_TARGETS.MESSAGE,
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
    use_regex: false,
    use_function_tool: false,
    regex: [],
    searxng_url: '',
    searxng_preferences: '',
};

/**
 * Ensures that the provided string ends with a newline.
 * @param {string} text String to ensure an ending newline
 * @returns {string} String with an ending newline
 */
function ensureEndNewline(text) {
    return text.endsWith('\n') ? text : text + '\n';
}

function createRegexRule() {
    const rule = { pattern: '', query: '' };
    extension_settings.websearch.regex.push(rule);
    saveSettingsDebounced();
    renderRegexRules();
}

async function renderRegexRules() {
    $('#websearch_regex_list').empty();
    for (const rule of extension_settings.websearch.regex) {
        const template = $(await renderExtensionTemplateAsync('third-party/Extension-WebSearch', 'regex'));
        template.find('.websearch_regex_pattern').val(rule.pattern).on('input', function () {
            rule.pattern = String($(this).val());
            saveSettingsDebounced();
        });
        template.find('.websearch_regex_query').val(rule.query).on('input', function () {
            rule.query = String($(this).val());
            saveSettingsDebounced();
        });
        template.find('.websearch_regex_delete').on('click', () => {
            if (!confirm('Are you sure?')) {
                return;
            }

            const index = extension_settings.websearch.regex.indexOf(rule);
            extension_settings.websearch.regex.splice(index, 1);
            saveSettingsDebounced();
            renderRegexRules();
        });
        $('#websearch_regex_list').append(template);
    }
}

async function isSearchAvailable() {
    if (extension_settings.websearch.source === WEBSEARCH_SOURCES.SERPAPI && !secret_state[SECRET_KEYS.SERPAPI]) {
        console.debug('WebSearch: no SerpApi key found');
        return false;
    }

    if (extension_settings.websearch.source === WEBSEARCH_SOURCES.EXTRAS && !modules.includes('websearch')) {
        console.debug('WebSearch: no websearch Extras module');
        return false;
    }

    if (extension_settings.websearch.source === WEBSEARCH_SOURCES.PLUGIN && !(await probeSeleniumSearchPlugin())) {
        console.debug('WebSearch: no websearch server plugin');
        return false;
    }

    if (extension_settings.websearch.source === WEBSEARCH_SOURCES.SEARXNG && !extension_settings.websearch.searxng_url) {
        console.debug('WebSearch: no SearXNG URL');
        return false;
    }

    if (extension_settings.websearch.source === WEBSEARCH_SOURCES.TAVILY && !secret_state[SECRET_KEYS.TAVILY]) {
        console.debug('WebSearch: no Tavily key found');
        return false;
    }

    return true;
}

/**
 * Determines whether the function tool can be used.
 * @returns {boolean} Whether the function tool can be used
 */
function canUseFunctionTool() {
    const { isToolCallingSupported } = SillyTavern.getContext();
    if (typeof isToolCallingSupported !== 'function') {
        console.debug('WebSearch: tool calling is not supported');
        return false;
    }

    return isToolCallingSupported();
}

async function onWebSearchPrompt(chat) {
    if (extension_settings.websearch.use_function_tool && canUseFunctionTool()) {
        console.debug('WebSearch: using the function tool');
        return;
    }

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

        const isAvailable = await isSearchAvailable();

        if (!isAvailable) {
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

        const extensionPrompt = substituteParamsExtended(template, { text: text, query: searchQuery });
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

    if (extension_settings.websearch.use_regex) {
        for (const rule of extension_settings.websearch.regex) {
            const regex = regexFromString(rule.pattern);

            if (regex && regex.test(message)) {
                const groups = message.match(regex);
                const query = substituteParamsExtended(rule.query).replace(/\$(\d+)/g, (_, i) => groups[i] || '');
                console.debug('WebSearch: regex rule matched', rule.pattern, query);
                return query;
            }
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
                linkResult += ensureEndNewline(substituteParamsExtended(extension_settings.websearch.visit_block_header, { query: query, text: text, link: link }));
            }
        }
    }

    if (!linkResult) {
        console.debug('WebSearch: no text to attach');
        return '';
    }

    const fileHeader = ensureEndNewline(substituteParamsExtended(extension_settings.websearch.visit_file_header, { query: query }));
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
        if (extension_settings.websearch.visit_target === VISIT_TARGETS.DATA_BANK) {
            const fileExists = await isFileExistsInDataBank(query);

            if (fileExists) {
                return;
            }
        }

        const fileName = `websearch - ${query} - ${Date.now()}.txt`;
        const fileText = await visitLinks(query, links);

        if (!fileText) {
            return;
        }

        if (extension_settings.websearch.visit_target === VISIT_TARGETS.DATA_BANK) {
            await uploadToDataBank(fileName, fileText);
        } else {
            const base64Data = window.btoa(unescape(encodeURIComponent(fileText)));
            const uniqueFileName = `${Date.now()}_${getStringHash(fileName)}.txt`;
            const fileUrl = await uploadFileAttachment(uniqueFileName, base64Data);

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
        }
    } catch (error) {
        console.error('WebSearch: failed to attach the file', error);
    }
}

/**
 * Checks if the file for the search query already exists in the Data Bank.
 * @param {string} query Search query
 * @returns {Promise<boolean>} Whether the file exists
 */
async function isFileExistsInDataBank(query) {
    try {
        const { getDataBankAttachmentsForSource } = await import('../../../chats.js');
        const attachments = await getDataBankAttachmentsForSource('chat');
        const existingAttachment = attachments.find(x => x.name.startsWith(`websearch - ${query} - `));
        if (existingAttachment) {
            console.debug('WebSearch: file for such query already exists in the Data Bank');
            return true;
        }
        return false;
    } catch (error) {
        // Prevent visiting links if the Data Bank is not available
        toastr.error('Data Bank module is not available');
        console.error('WebSearch: failed to check if the file exists in the Data Bank', error);
        return true;
    }
}

/**
 * Uploads the file to the Data Bank.
 * @param {string} fileName File name
 * @param {string} fileText File text
 * @returns {Promise<void>}
 */
async function uploadToDataBank(fileName, fileText) {
    try {
        const { uploadFileAttachmentToServer } = await import('../../../chats.js');
        const file = new File([fileText], fileName, { type: 'text/plain' });
        await uploadFileAttachmentToServer(file, 'chat');
    } catch (error) {
        console.error('WebSearch: failed to import the chat module', error);
    }
}

/**
 * Visits the provided web link and extracts the text from the resulting HTML.
 * @param {string} link Web link to visit
 * @returns {Promise<{link: string, text:string}>} Extracted text
 */
async function visitLink(link) {
    try {
        const result = await fetch('/api/search/visit', {
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
    const result = await fetch('/api/search/serpapi', {
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
 * Performs a search query via the Selenium search plugin.
 * @param {string} query Search query
 * @returns {Promise<{textBits: string[], links: string[]}>} Lines of search results.
 */
async function doSeleniumPluginQuery(query) {
    const result = await fetch('/api/plugins/selenium/search', {
        method: 'POST',
        headers: getRequestHeaders(),
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
 * Performs a search query via Tavily.
 * @param {string} query Search query
 * @returns {Promise<{textBits: string[], links: string[]}>} Lines of search results.
 */
async function doTavilyQuery(query) {
    const result = await fetch('/api/search/tavily', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ query }),
    });

    if (!result.ok) {
        console.debug('WebSearch: search request failed', result.statusText);
        return;
    }

    const textBits = [];
    const links = [];
    const data = await result.json();

    if (data.answer) {
        textBits.push(data.answer);
    }

    if (Array.isArray(data.results)) {
        data.results.forEach(x => {
            textBits.push(`${x.title}\n${x.content}`);
            links.push(x.url);
        });
    }

    return { textBits, links };
}

async function doSearxngQuery(query) {
    const result = await fetch('/api/search/searxng', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ query, baseUrl: extension_settings.websearch.searxng_url, preferences: extension_settings.websearch.searxng_preferences }),
    });

    if (!result.ok) {
        console.debug('WebSearch: search request failed', result.statusText);
        return;
    }

    const data = await result.text();
    const doc = new DOMParser().parseFromString(data, 'text/html');
    const textBits = Array.from(doc.querySelectorAll('#urls p.content')).map(x => x.textContent.trim()).filter(x => x);
    const links = Array.from(doc.querySelectorAll('#urls .url_header, #urls .url_wrapper')).map(x => x.getAttribute('href')).filter(x => x);

    if (doc.querySelector('.infobox')) {
        const infoboxText = doc.querySelector('.infobox p')?.textContent?.trim();
        const infoboxLink = doc.querySelector('.infobox a')?.getAttribute('href');

        if (infoboxText) {
            textBits.unshift(infoboxText);
        }

        if (infoboxLink) {
            links.unshift(infoboxLink);
        }
    }

    return { textBits, links };
}

/**
 * Probes the Selenium search plugin to check if it's available.
 * @returns {Promise<boolean>} Whether the plugin is available
 */
async function probeSeleniumSearchPlugin() {
    try {
        const result = await fetch('/api/plugins/selenium/probe', {
            method: 'POST',
            headers: getRequestHeaders(),
        });

        if (!result.ok) {
            console.debug('WebSearch: plugin probe failed', result.statusText);
            return false;
        }

        return true;
    } catch (error) {
        console.error('WebSearch: plugin probe failed', error);
        return false;
    }
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
                case WEBSEARCH_SOURCES.PLUGIN:
                    return await doSeleniumPluginQuery(query);
                case WEBSEARCH_SOURCES.SEARXNG:
                    return await doSearxngQuery(query);
                case WEBSEARCH_SOURCES.TAVILY:
                    return await doTavilyQuery(query);
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

/**
 * Provides an interface for the Data Bank to interact with the extension.
 */
class WebSearchScraper {
    constructor() {
        this.id = 'websearch';
        this.name = 'Web Search';
        this.description = 'Perform a web search and download the results.';
        this.iconClass = 'fa-solid fa-search';
        this.iconAvailable = true;
    }

    /**
     * Check if the scraper is available.
     * @returns {Promise<boolean>} Whether the scraper is available
     */
    async isAvailable() {
        return await isSearchAvailable();
    }

    /**
     * Scrape file attachments from a webpage.
     * @returns {Promise<File[]>} File attachments scraped from the webpage
     */
    async scrape() {
        try {
            const template = $(await renderExtensionTemplateAsync('third-party/Extension-WebSearch', 'search-scrape', {}));
            let query = '';
            let maxResults = extension_settings.websearch.visit_count;
            let output = 'multiple';
            let snippets = false;
            template.find('input[name="searchScrapeQuery"]').on('input', function () {
                query = String($(this).val());
            });
            template.find('input[name="searchScrapeMaxResults"]').val(maxResults).on('input', function () {
                maxResults = Number($(this).val());
            });
            template.find('input[name="searchScrapeOutput"]').on('input', function () {
                output = String($(this).val());
            });
            template.find('input[name="searchScrapeSnippets"]').on('change', function () {
                snippets = $(this).prop('checked');
            });

            const confirm = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '', { okButton: 'Scrape', cancelButton: 'Cancel' });

            if (!confirm) {
                return;
            }

            const toast = toastr.info('Working, please wait...');
            const searchResult = await performSearchRequest(query, { useCache: false });

            if (!Array.isArray(searchResult?.links) || searchResult.links.length === 0) {
                console.debug('WebSearch: no links to scrape');
                return [];
            }

            const visitResults = [];

            for (let i = 0; i < searchResult.links.length; i++) {
                if (i >= maxResults) {
                    break;
                }

                const link = searchResult.links[i];

                if (!isAllowedUrl(link)) {
                    continue;
                }

                const visitResult = await visitLink(link);

                if (visitResult) {
                    visitResults.push(visitResult);
                }
            }

            const files = [];

            if (snippets) {
                const fileName = `snippets - ${query} - ${Date.now()}.txt`;
                const file = new File([searchResult.text], fileName, { type: 'text/plain' });
                files.push(file);
            }

            if (output === 'single') {
                let result = '';

                for (const visitResult of visitResults) {
                    if (visitResult.text) {
                        result += ensureEndNewline(substituteParamsExtended(extension_settings.websearch.visit_block_header, { query: query, link: visitResult.link, text: visitResult.text }));
                    }
                }

                const fileHeader = ensureEndNewline(substituteParamsExtended(extension_settings.websearch.visit_file_header, { query: query }));
                const fileText = fileHeader + result;
                const fileName = `websearch - ${query} - ${Date.now()}.txt`;
                const file = new File([fileText], fileName, { type: 'text/plain' });
                files.push(file);
            }

            if (output === 'multiple') {
                for (const result of visitResults) {
                    if (result.text) {
                        const domain = new URL(result.link).hostname;
                        const fileName = `${query} - ${domain} - ${Date.now()}.txt`;
                        const file = new File([result.text], fileName, { type: 'text/plain' });
                        files.push(file);
                    }
                }
            }

            toastr.clear(toast);
            return files;
        } catch (error) {
            console.error('WebSearch: error while scraping', error);
        }
    }
}

function registerFunctionTools() {
    try {
        const { registerFunctionTool, unregisterFunctionTool } = SillyTavern.getContext();

        if (!registerFunctionTool || !unregisterFunctionTool) {
            console.log('WebSearch: Function tools are not supported');
            return;
        }

        if (!extension_settings.websearch.use_function_tool) {
            unregisterFunctionTool('WebSearch');
            return;
        }

        const webSearchSchema = Object.freeze({
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Web Query used in search engine.',
                },
            },
            required: [
                'query',
            ],
        });

        const visitLinksSchema = Object.freeze({
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                links: {
                    type: 'array',
                    items: {
                        type: 'string',
                    },
                    description: 'Web links to visit.',
                },
            },
            required: [
                'links',
            ],
        });

        registerFunctionTool({
            name: 'WebSearch',
            displayName: 'Web Search',
            description: 'Search the web and get the content of the relevant pages. Search for unknown knowledge, public personalities, up-to-date information, weather, news, etc.',
            parameters: webSearchSchema,
            formatMessage: (args) => args?.query ? `Searching the web for: ${args?.query}` : '',
            action: async (args) => {
                if (!args) throw new Error('No arguments provided');
                if (!args.query) throw new Error('No query provided');
                if (!(await isSearchAvailable())) throw new Error('Search is not available');
                const search = await performSearchRequest(args.query, { useCache: true });
                return search;
            },
        });

        registerFunctionTool({
            name: 'VisitLinks',
            displayName: 'Visit Links',
            description: 'Visit the web links and get the content of the relevant pages.',
            parameters: visitLinksSchema,
            formatMessage: (args) => args?.links ? `Visiting the web links` : '',
            action: async (args) => {
                if (!args) throw new Error('No arguments provided');
                if (!args.links) throw new Error('No links provided');
                if (!(await isSearchAvailable())) throw new Error('Search is not available');
                const visitResults = [];

                for (const link of args.links) {
                    if (!isAllowedUrl(link)) {
                        continue;
                    }

                    const visitResult = await visitLink(link);

                    if (visitResult) {
                        visitResults.push(visitResult);
                    }
                }

                return visitResults;
            },
        });
    } catch (error) {
        console.error('WebSearch: Function tools failed to register:', error);
    }
}

jQuery(async () => {
    if (!extension_settings.websearch) {
        extension_settings.websearch = structuredClone(defaultSettings);
    }

    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings.websearch[key] === undefined) {
            extension_settings.websearch[key] = defaultSettings[key];
        }
    }

    const html = await renderExtensionTemplateAsync('third-party/Extension-WebSearch', 'settings');

    function switchSourceSettings() {
        $('#websearch_extras_settings').toggle(extension_settings.websearch.source === WEBSEARCH_SOURCES.EXTRAS || extension_settings.websearch.source === WEBSEARCH_SOURCES.PLUGIN);
        $('#serpapi_settings').toggle(extension_settings.websearch.source === WEBSEARCH_SOURCES.SERPAPI);
        $('#websearch_searxng_settings').toggle(extension_settings.websearch.source === WEBSEARCH_SOURCES.SEARXNG);
        $('#websearch_tavily_settings').toggle(extension_settings.websearch.source === WEBSEARCH_SOURCES.TAVILY);
    }

    const getContainer = () => $(document.getElementById('websearch_container') ?? document.getElementById('extensions_settings2'));
    getContainer().append(html);
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
        const key = await callGenericPopup('Add a SerpApi key', POPUP_TYPE.INPUT, '', {
            rows: 2,
            customButtons: [{
                text: 'Remove Key',
                appendAtEnd: true,
                result: POPUP_RESULT.NEGATIVE,
                action: async () => {
                    await writeSecret(SECRET_KEYS.SERPAPI, '');
                    $('#serpapi_key').toggleClass('success', !!secret_state[SECRET_KEYS.SERPAPI]);
                    toastr.success('API Key removed');
                },
            }],
        });

        if (key) {
            await writeSecret(SECRET_KEYS.SERPAPI, String(key).trim());
            toastr.success('API Key saved');
        }

        $('#serpapi_key').toggleClass('success', !!secret_state[SECRET_KEYS.SERPAPI]);
    });
    $('#tavily_key').toggleClass('success', !!secret_state[SECRET_KEYS.TAVILY]);
    $('#tavily_key').on('click', async () => {
        const key = await callGenericPopup('Add a Tavily key', POPUP_TYPE.INPUT, '', {
            rows: 2,
            customButtons: [{
                text: 'Remove Key',
                appendAtEnd: true,
                result: POPUP_RESULT.NEGATIVE,
                action: async () => {
                    await writeSecret(SECRET_KEYS.TAVILY, '');
                    $('#tavily_key').toggleClass('success', !!secret_state[SECRET_KEYS.TAVILY]);
                    toastr.success('API Key removed');
                },
            }],
        });

        if (key) {
            await writeSecret(SECRET_KEYS.TAVILY, String(key).trim());
            toastr.success('API Key saved');
        }

        $('#tavily_key').toggleClass('success', !!secret_state[SECRET_KEYS.TAVILY]);
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
    $(`input[name="websearch_visit_target"][value="${extension_settings.websearch.visit_target}"]`).prop('checked', true);
    $('input[name="websearch_visit_target"]').on('input', () => {
        extension_settings.websearch.visit_target = Number($('input[name="websearch_visit_target"]:checked').val());
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
    $('#websearch_use_regex').prop('checked', extension_settings.websearch.use_regex);
    $('#websearch_use_regex').on('change', () => {
        extension_settings.websearch.use_regex = !!$('#websearch_use_regex').prop('checked');
        saveSettingsDebounced();
    });

    $('#websearch_regex_add').on('click', createRegexRule);
    $('#websearch_searxng_url').val(extension_settings.websearch.searxng_url);
    $('#websearch_searxng_url').on('input', () => {
        extension_settings.websearch.searxng_url = String($('#websearch_searxng_url').val());
        saveSettingsDebounced();
    });

    $('#websearch_searxng_preferences').val(extension_settings.websearch.searxng_preferences);
    $('#websearch_searxng_preferences').on('input', () => {
        extension_settings.websearch.searxng_preferences = String($('#websearch_searxng_preferences').val());
        saveSettingsDebounced();
    });

    $('#websearch_use_function_tool').prop('checked', extension_settings.websearch.use_function_tool);
    $('#websearch_use_function_tool').on('change', () => {
        extension_settings.websearch.use_function_tool = !!$('#websearch_use_function_tool').prop('checked');
        registerFunctionTools();
        saveSettingsDebounced();
    });

    switchSourceSettings();
    registerFunctionTools();
    await renderRegexRules();

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

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'websearch',
        helpString: 'Performs a web search query. Use named arguments to specify what to return - page snippets, full parsed pages, or both.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'query',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                acceptsMultiple: false,
            }),
        ],
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'snippets',
                description: 'Include page snippets',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                isRequired: false,
                acceptsMultiple: false,
                defaultValue: String(true),
                forceEnum: true,
                enumProvider: commonEnumProviders.boolean('trueFalse'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'links',
                description: 'Include full parsed pages',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                isRequired: false,
                acceptsMultiple: false,
                defaultValue: String(false),
                forceEnum: true,
                enumProvider: commonEnumProviders.boolean('trueFalse'),
            }),
        ],
        callback: async (args, query) => {
            const includeSnippets = !isFalseBoolean(String(args.snippets));
            const includeLinks = isTrueBoolean(String(args.links));

            if (!query) {
                toastr.warning('No search query specified');
                return '';
            }

            if (!includeSnippets && !includeLinks) {
                toastr.warning('No search result type specified');
                return '';
            }

            const result = await performSearchRequest(String(query), { useCache: true });

            let output = includeSnippets ? result.text : '';

            if (includeLinks && Array.isArray(result.links) && result.links.length > 0) {
                const visitResult = await visitLinks(String(query), result.links);
                output += '\n' + visitResult;
            }

            return output;
        },
    }));

    const context = getContext();
    if (typeof context.registerDataBankScraper === 'function') {
        context.registerDataBankScraper(new WebSearchScraper());
    }
});
