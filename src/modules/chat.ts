import axios from 'axios';
import { v1 as uuidv1 } from 'uuid';
//import { useCachedModels } from './mlModels';
import { Tool, tools, ExtendedTool } from './tools';
import { getEncoding } from 'js-tiktoken';
import {
  LLMTask,
  OpenAIMessage,
  ChatCompletionResponse,
  OpenRouterGenerationInfo,
} from './types';
import { taskChain, processTasksQueue } from './taskManager';

function getAPIURLs(baseURL: string) {
  return {
    chat: baseURL + '/chat/completions',
    models: baseURL + '/models',
  };
}

export function getBackendUrls(backend: 'openai' | 'openrouter') {
  let baseURL;
  if (backend == 'openai') {
    baseURL = 'https://api.openai.com/v1/';
  } else {
    baseURL = 'https://openrouter.ai/api/v1';
  }
  return baseURL;
}

export function getApikey(chatState: ChatStateType) {
  return getBackendUrls('openai') == chatState.baseURL
    ? chatState.openAIApiKey
    : chatState.openRouterAIApiKey;
}

export function getSelectedModel(chatState: ChatStateType) {
  return getBackendUrls('openai') == chatState.baseURL
    ? chatState.openAIModel
    : chatState.openrouterAIModel;
}

export function defaultChatState() {
  return {
    Tasks: {} as Record<string, LLMTask>,
    // this refers to the task chain that we have selected. We select one task and then
    // put the chain together by following the parentIds.
    selectedTaskId: undefined as string | undefined,
    openrouterAIModel: 'mistralai/mistral-7b-instruct', //model which is generally chosen for a task if not explicitly specified
    openAIModel: 'gpt-3.5-turbo',
    openAIApiKey: '',
    openRouterAIApiKey: '',
    siteUrl: 'https://taskyon.xyntopia.com',
    summaryModel: 'Xenova/distilbart-cnn-6-6',
    baseURL: getBackendUrls('openrouter'),
  };
}

function openRouterUsed(chatState: ChatStateType) {
  return getBackendUrls('openrouter') == chatState.baseURL;
}
export type ChatStateType = ReturnType<typeof defaultChatState>;
type ChatCompletionRequest = {
  // An array of messages in the conversation.
  messages: Array<OpenAIMessage>;
  // The ID of the model to use.
  model: string;
  // Controls how the model calls functions.
  function_call?:
    | 'none'
    | 'auto'
    | {
        // The name of the function to call.
        name: string;
      };
  // Penalty for repeating tokens.
  frequency_penalty?: number | null;
  // Details on how the model calls functions.
  functions?: Array<Tool>;
  // Modify the likelihood of specified tokens.
  logit_bias?: Record<string, number> | null;
  // Maximum number of tokens to generate.
  max_tokens?: number | null;
  // Number of chat completion choices to generate.
  n?: number | null;
  // Penalty for new tokens in the text.
  presence_penalty?: number | null;
  // Sequences to stop generating tokens.
  stop?: string | Array<string> | null;
  // Enable partial message deltas streaming.
  stream?: boolean | null;
  // Sampling temperature for output.
  temperature?: number | null;
  // Probability mass for nucleus sampling.
  top_p?: number | null;
  // Unique identifier for your end-user (optional).
  user?: string;
};

const enc = getEncoding('gpt2');

export function countStringTokens(txt: string) {
  // Tokenize the content
  const content = enc.encode(txt);
  return content.length;
}

function estimateTokens(task: LLMTask) {
  const content = countStringTokens(task.content || '');
  // Return the token count
  const total = content;
  return total;
}

function countChatTokens(chatMessages: OpenAIMessage[]): number {
  let totalTokens = 0;
  for (const message of chatMessages) {
    if (message.content) {
      totalTokens += countStringTokens(message.content);
    }
  }
  return totalTokens;
}

export function countToolTokens(functionList: ExtendedTool[]): number {
  let totalTokens = 0;

  // Iterate through each tool in the functionList array
  for (const tool of functionList) {
    // Get the description and stringify the parameters of the tool
    const description = tool.description;
    const stringifiedParameters = JSON.stringify(tool.parameters, null, 2); // Pretty print the JSON string

    // Count the tokens in the description and stringified parameters using countStringTokens
    const descriptionTokens = countStringTokens(description);
    const parametersTokens = countStringTokens(stringifiedParameters);

    // Sum the tokens of the description and stringified parameters for this tool
    totalTokens += descriptionTokens + parametersTokens;
  }

  return totalTokens;
}

export function estimateChatTokens(
  newResponseTask: LLMTask,
  chatState: ChatStateType
) {
  const chat: OpenAIMessage[] = buildChatFromTask(newResponseTask, chatState);
  const functions: ExtendedTool[] = mapFunctionNames(
    newResponseTask.allowedTools || []
  );
  const promptTokens = estimateTokens(newResponseTask);
  const chatTokens = countChatTokens(chat);
  const functionTokens = Math.floor(countToolTokens(functions) * 0.7);
  return {
    promptTokens,
    chatTokens,
    functionTokens,
    total: chatTokens + functionTokens,
  };
}

function generateHeaders(chatState: ChatStateType) {
  let headers: Record<string, string> = {
    Authorization: `Bearer ${getApikey(chatState)}`,
    'Content-Type': 'application/json',
  };

  if (openRouterUsed(chatState)) {
    headers = {
      ...headers,
      'HTTP-Referer': `${chatState.siteUrl}`, // To identify your app. Can be set to localhost for testing
      'X-Title': `${chatState.siteUrl}`, // Optional. Shows on openrouter.ai
    };
  }

  return headers;
}

// calls openRouter OR OpenAI  chatmodels
async function callLLM(
  chatMessages: OpenAIMessage[],
  functions: Array<Tool>,
  chatState: ChatStateType
) {
  const payload: ChatCompletionRequest = {
    model: getSelectedModel(chatState),
    messages: chatMessages,
    user: 'taskyon',
    temperature: 0.0,
    stream: false,
    n: 1,
  };

  if (functions.length > 0) {
    payload.function_call = 'auto';
    payload.functions = functions;
  }

  const headers = generateHeaders(chatState);

  const response = await axios.post<ChatCompletionResponse>(
    getAPIURLs(chatState.baseURL).chat,
    payload,
    { headers }
  );
  console.log('AI responded:', response);
  const chatCompletion = response.data;

  if (openRouterUsed(chatState)) {
    const GENERATION_ID = response.data.id;
    const headers = generateHeaders(chatState);
    const generation = await axios.get<OpenRouterGenerationInfo>(
      `https://openrouter.ai/api/v1/generation?id=${GENERATION_ID}`,
      { headers }
    );

    const generationInfo = generation.data.data;

    if (
      generationInfo.native_tokens_completion &&
      generationInfo.native_tokens_prompt
    ) {
      chatCompletion.usage = {
        prompt_tokens: generationInfo.native_tokens_prompt,
        completion_tokens: generationInfo.native_tokens_completion,
        total_tokens:
          generationInfo.native_tokens_prompt +
          generationInfo.native_tokens_completion,
        origin: generationInfo.origin,
        inference_costs: generationInfo.usage,
      };
    }
  }

  return chatCompletion;
}

export function sendMessage(
  message: string,
  chatState: ChatStateType,
  functionNames: string[]
) {
  // adds a "sendMessage task to the Task stack"
  console.log('send message');
  if (message.trim() === '') return;

  const currentTask: LLMTask = {
    role: 'user',
    state: 'Open',
    content: message,
    debugging: {},
    id: uuidv1(),
    childrenIDs: [],
    allowedTools: functionNames,
  };

  if (chatState.selectedTaskId) {
    currentTask.parentID = chatState.selectedTaskId;
    chatState.Tasks[chatState.selectedTaskId].childrenIDs.push(currentTask.id);
  }

  // Push it to the "overall Tasks List"
  chatState.Tasks[currentTask.id] = currentTask;

  // make it the acive task!
  chatState.selectedTaskId = currentTask.id;

  // Push the new task to processTasksQueue
  // we are using the reference from chatState here isntead of currentTask,
  // because we want to preserve reactivity from librares such as react
  // or vue. And this way we can use the reactive object!
  processTasksQueue.push(chatState.Tasks[currentTask.id]);
}

function buildChatFromTask(task: LLMTask, chatState: ChatStateType) {
  const openAIConversation = [] as OpenAIMessage[];
  const conversation = taskChain(task.id, chatState.Tasks);

  if (conversation) {
    openAIConversation.push(
      ...conversation
        .map((mId) => {
          const m = chatState.Tasks[mId];
          const message: OpenAIMessage = {
            role: m.role,
            content: m.content,
          };
          if (m.role == 'function') {
            message.name = m.authorId;
            message.content = m.result?.content || null;
          }
          return message;
        })
        .filter((m) => m.content) // OpenAI doesn't accept messages with zero content, even though they generate it themselfs
    );
  }
  return openAIConversation;
}

function addTask2Tree(
  task: {
    role: LLMTask['role'];
    content?: LLMTask['content'];
    context?: LLMTask['context'];
    state?: LLMTask['state'];
    id?: LLMTask['id'];
    debugging?: LLMTask['debugging'];
  },
  parent: LLMTask,
  chatState: ChatStateType,
  execute = true
) {
  const newTask: LLMTask = {
    role: task.role,
    parentID: parent.id,
    content: task.content || null,
    state: task.state || 'Open',
    childrenIDs: [],
    debugging: task.debugging || {},
    id: task.id || uuidv1(),
    context: task.context,
  };
  if (task.context) {
    if (task.role == 'function') {
      newTask.authorId = task.context?.function?.name;
    }
  }

  console.log('create new Task:', newTask.id);

  // connect task to task tree
  chatState.Tasks[newTask.id] = newTask;
  parent.childrenIDs.push(newTask.id);
  // Push the new function task to processTasksQueue
  if (execute) {
    processTasksQueue.push(chatState.Tasks[newTask.id]);
    chatState.Tasks[newTask.id].state = 'Queued';
  }
  chatState.selectedTaskId = newTask.id;
  return newTask.id;
}

// return the last task that was created in the chain.
function createNewTasksFromChatResponse(
  response: ChatCompletionResponse,
  parentTask: LLMTask,
  chatState: ChatStateType
) {
  // Process the response and create new tasks if necessary
  if (response.choices.length > 0) {
    const choice = response.choices[0];
    // put AI response in our chain as a new, completed task...
    // TODO: theoretically the user "viewing" the task would be its completion..
    //       so we could create it before sending it and then wait for AI to respond...
    const newResponseTaskId = addTask2Tree(
      {
        state: 'Completed',
        role: choice.message.role,
        content: choice.message.content,
        debugging: {
          usedTokens: response.usage?.total_tokens,
          inference_costs: response.usage?.inference_costs,
          aiResponse: response,
        },
        id: response.id,
      },
      parentTask,
      chatState,
      false
    );

    // and push newly created tasks to our task list. they were already processed, so we don't need to
    // add them to our task queue.
    if (choice.message.content) {
      // we are using the reference to the object here in order to preserve potential proxys
      // introduced by things like vue :).
      chatState.selectedTaskId = chatState.Tasks[newResponseTaskId].id;
      return chatState.Tasks[newResponseTaskId];
    } else if (
      choice.finish_reason === 'function_call' &&
      choice.message.function_call
    ) {
      const func = choice.message.function_call;

      // Try to parse the function arguments from JSON, log and re-throw the error if parsing fails
      let funcArguments: Record<string, unknown> | string;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        funcArguments = JSON.parse(func.arguments);
      } catch (parseError) {
        // in this case, we assume, that we can call the function with the return string!
        funcArguments = func.arguments;
      }

      chatState.Tasks[newResponseTaskId].result = {
        type: 'FunctionCall',
        functionCallDetails: func,
      };
      const funcTaskid = addTask2Tree(
        {
          role: 'function',
          content: null,
          context: {
            function: {
              name: func.name,
              arguments: funcArguments,
            },
          },
        },
        chatState.Tasks[newResponseTaskId],
        chatState
      );
      return chatState.Tasks[funcTaskid];
    }
  }
}

export function bigIntToString(obj: unknown): unknown {
  if (obj === null) {
    return obj;
  }

  if (typeof obj === 'bigint') {
    return obj.toString();
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => bigIntToString(item));
  }

  if (typeof obj === 'object') {
    const result: { [key: string]: unknown } = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        result[key] = bigIntToString((obj as Record<string, unknown>)[key]);
      }
    }
    return result;
  }

  return obj;
}

function mapFunctionNames(toolNames: string[]) {
  return toolNames?.map((t) => tools[t]);
}

// Function to process OpenAI conversation
export async function processOpenAIConversation(
  task: LLMTask,
  chatState: ChatStateType
) {
  const openAIConversation = buildChatFromTask(task, chatState);
  if (openAIConversation) {
    const functions = mapFunctionNames(task.allowedTools || []) || [];
    const response = await callLLM(openAIConversation, functions, chatState);
    if (response.usage) {
      // openai sends back the exact number of prompt tokens :)
      task.debugging.usedTokens = response.usage.prompt_tokens;
    }
    createNewTasksFromChatResponse(response, task, chatState);
  }
}

export function deleteConversation(leafId: string, chatState: ChatStateType) {
  if (chatState.selectedTaskId == leafId) {
    chatState.selectedTaskId = undefined;
  }

  let currentTaskId = leafId;
  while (currentTaskId) {
    const currentTask = chatState.Tasks[currentTaskId];
    if (!currentTask) break; // Break if a task doesn't exist

    // Check if the parent task has more than one child
    if (currentTask.parentID) {
      const parentTask = chatState.Tasks[currentTask.parentID];
      if (parentTask && parentTask.childrenIDs.length > 1) {
        break; // Stop deletion if the parent task has more than one child
      }
    }

    // Delete the current task
    delete chatState.Tasks[currentTaskId];

    if (currentTask.parentID) {
      // Move to the parent task
      currentTaskId = currentTask.parentID;
    } else {
      break;
    }
  }
}

interface Permission {
  id: string;
  object: string;
  created: number;
  allow_create_engine: boolean;
  allow_sampling: boolean;
  allow_logprobs: boolean;
  allow_search_indices: boolean;
  allow_view: boolean;
  allow_fine_tuning: boolean;
  organization: string;
  group: null | string;
  is_blocking: boolean;
}

export interface Model {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  permission?: Permission[];
  root?: string;
  parent?: null | string;
  pricing?: {
    prompt: string;
    completion: string;
    discount: number;
  };
  context_length?: number;
  top_provider?: {
    max_completion_tokens: number;
  };
  per_request_limits?: {
    prompt_tokens: string;
    completion_tokens: string;
  };
}

// Update the availableModels function to return a list of models
export async function availableModels(
  baseURL: string,
  apiKey: string
): Promise<Model[]> {
  try {
    // Setting up the Axios requsest
    const response = await axios.get<{ data: Model[] }>(
      getAPIURLs(baseURL).models,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Cache-Control': 'max-stale=3600',
        },
      }
    );

    // Return the list of models directly
    return response.data.data;
  } catch (error) {
    console.error('Error fetching models:', error);
    throw error; // re-throwing the error to be handled by the calling code
  }
}
