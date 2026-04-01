export interface Endpoint {
  config: Config;
  meta: Meta;
  [key: string]: any; // Allow dynamic string keys
}
  
export interface Config {
  "allowed-ids": string[];
  blacklist: string[];
  channels: Channels;
  emoji_filtering: boolean;
  emojis: Emoji[];
  isbeta: boolean;
  logs: Logs;
  "self-user": boolean;
  webhooks: Webhooks;
  [key: string]: any; // Allow dynamic string keys
}

export interface Channels {
  discord: string[];
  guilded: string[];
  nerimity: string[];
  revolt: string[];
  [key: string]: any; // Allow dynamic string keys
}

export interface Emoji {
  discord: string;
  guilded?: string;
  nerimity: string;
  revolt: string;	
  [key: string]: any; // Allow dynamic string keys
}

export interface Logs {
  discord: string;
  guilded: any;
  nerimity: any;
  revolt: any;
  [key: string]: any; // Allow dynamic string keys
}

export interface Webhooks {
  discord: string[];
  guilded: string[];
  nerimity: string[];
  revolt: string[];
  [key: string]: any; // Allow dynamic string keys
}

export interface Meta {
  _message_cache: any[];
  message: Message;
  read: Read;
  sender: any;
  "sender-channel": any;
  trigger: boolean;
  [key: string]: any; // Allow dynamic string keys
}

export interface Message {
  attachments: any[];
  author: Author;
  content: any;
  embed: Embed;
  isReply: boolean;
  reply: Reply;
  sender: string | null;
  "sender-channel": string | null;
  [key: string]: any; // Allow dynamic string keys
}

export interface Author {
  avatar: any;
  id: any;
  name: any;
  [key: string]: any; // Allow dynamic string keys
}

export interface Embed {
  description: string;
  fields: any[];
  footer: string;
  image: string;
  thumbnail: string;
  title: string;
  [key: string]: any; // Allow dynamic string keys
}

export interface Reply {
  author: any;
  message: any;
  [key: string]: any; // Allow dynamic string keys
}

export interface Read {
  discord: boolean;
  guilded: boolean;
  nerimity: boolean;
  revolt: boolean;
  [key: string]: boolean; // Allow dynamic string keys
}