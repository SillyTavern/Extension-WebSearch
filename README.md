# Extension-WebSearch

Add Google web search results to LLM prompts (requires SerpApi key).

Get the key here: https://serpapi.com/dashboard

## How to use

1. Make sure you use the latest version of SillyTavern (staging branch preferred).
2. Install the extension via the "Download Extensions & Assets" menu in SillyTavern.
3. Open the "Web Search" extension settings, set your API key, and enable the extension.
4. The web search results will be added to the prompt organically as you chat. **Only user messages trigger the search.**
5. Optionally, configure the settings to your liking.

## Settings.

1. Enabled - toggles the extension on and off.
2. Prompt Budget - sets the maximum capacity of the inserted text (in characters of text, NOT tokens). Rule of thumb: 1 token ~ 3-4 characters, adjust according to your model's context limits. Default = 1500 characters.
3. Cache Lifetime - how long (in seconds) the search results are cached for your prompt. Default = one week.
4. Max Words - how many words are included in the search query (including the trigger phrase). Google has a limit of about 32 words per prompt. Default = 10 words.
5. Trigger Phrases - add phrases that will trigger the search, one by one. It can be anywhere in the message, and the query starts from the trigger word and spans to "Max Words" total. Priority of triggers: first by order in the textbox, then the first one in the user message.
6. Insertion Template - how the result gets inserted into the prompt. Supports the usual macro + special macro: `{{query}}` for search query and `{{text}}` for search results.
7. Injection Position - where the result goes in the prompt. The same options as for the Author's Note: as in-chat injection or before/after system prompt.

## More info

The priority for search results:

1. Answer box
2. Knowledge graph
3. Page snippets (max 5)
4. Relevant questions (max 5)
