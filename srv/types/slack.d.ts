// Slack - Bolt
import {
  AllMiddlewareArgs,
  AppMentionEvent,
  GenericMessageEvent,
} from '@slack/bolt';

// Slack - File
export type File = NonNullable<GenericMessageEvent['files']>[number];

// Slack - App Mention Event With Files
export type AppMentionEventWithFiles = AppMentionEvent & {
  files?: File[];
};

// Slack - Web Client
export type WebClient = AllMiddlewareArgs['client'];
