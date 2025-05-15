export interface Endpoint {
  config: Config;
  meta: Meta;
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
}

export interface Channels {
  discord: string[];
  guilded: string[];
  nerimity: string[];
  revolt: string[];
}

export interface Emoji {
  discord: string;
  guilded?: string;
  nerimity: string;
  revolt: string;	
}

export interface Logs {
  discord: string;
  guilded: any;
  nerimity: any;
  revolt: any;
}

export interface Webhooks {
  discord: string[];
  guilded: string[];
  nerimity: string[];
  revolt: string[];
}

export interface Meta {
  _message_cache: any[];
  message: Message;
  read: Read;
  sender: any;
  "sender-channel": any;
  trigger: boolean;
}

export interface Message {
  attachments: any[];
  author: Author;
  content: any;
  embed: Embed;
  isReply: boolean;
  reply: Reply;
  sender: string;
  "sender-channel": string;
}

export interface Author {
  avatar: any;
  id: any;
  name: any;
}

export interface Embed {
  description: string;
  fields: any[];
  footer: string;
  image: string;
  thumbnail: string;
  title: string;
}

export interface Reply {
  author: any;
  message: any;
}

export interface Read {
  discord: boolean;
  guilded: boolean;
  nerimity: boolean;
  revolt: boolean;
}