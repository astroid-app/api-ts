import { Config } from './Endpoint';

export function validateConfig(config: Config): string[] | false {
    const errors: string[] = [];

    if (!config) {
        return errors;
    }

    const topLevelKeys = [
        "allowed-ids",
        "blacklist",
        "channels",
        "emoji_filtering",
        "emojis",
        "isbeta",
        "logs",
        "self-user",
        "webhooks"
    ];
    const configKeys = Object.keys(config);
    if (configKeys.length === 0) {
        errors.push('Config is empty');
    }
    configKeys.forEach((key) => {
        if (!topLevelKeys.includes(key)) {
            errors.push(`Invalid config key: ${key}`);
        }
    });

    // Validate data types and structures
    if (config["allowed-ids"] && !Array.isArray(config["allowed-ids"])) {
        errors.push('allowed-ids must be an array');
    }

    if (config.blacklist && !Array.isArray(config.blacklist)) {
        errors.push('blacklist must be an array');
    }

    if (config.emoji_filtering !== undefined && typeof config.emoji_filtering !== 'boolean') {
        errors.push('emoji_filtering must be a boolean');
    }

    if (config.isbeta !== undefined && typeof config.isbeta !== 'boolean') {
        errors.push('isbeta must be a boolean');
    }

    if (config["self-user"] !== undefined && typeof config["self-user"] !== 'boolean') {
        errors.push('self-user must be a boolean');
    }

    // Validate nested objects
    if (config.channels !== undefined && typeof config.channels !== 'object') {
        errors.push('channels must be a valid object');
    } else if (config.channels) {
        const channels = config.channels;
        if (channels.discord !== undefined && !Array.isArray(channels.discord)) {
            errors.push('channels.discord must be an array');
        }
        if (channels.guilded !== undefined && !Array.isArray(channels.guilded)) {
            errors.push('channels.guilded must be an array');
        }
        if (channels.nerimity !== undefined && !Array.isArray(channels.nerimity)) {
            errors.push('channels.nerimity must be an array');
        }
        if (channels.revolt !== undefined && !Array.isArray(channels.revolt)) {
            errors.push('channels.revolt must be an array');
        } else {
            if (channels.discord === undefined && channels.guilded === undefined && channels.nerimity === undefined && channels.revolt === undefined) {
            errors.push('At least one channel type (discord, guilded, nerimity, revolt) must be defined.');
            }
        }
    }

    if (config.emojis !== undefined && !Array.isArray(config.emojis)) {
        errors.push('emojis must be a valid array');
    } else if (config.emojis) {
        config.emojis.forEach((emoji, index) => {
            if (!emoji || typeof emoji !== 'object') {
                errors.push(`emojis[${index}] must be a valid object`);
            } else {
                if (emoji.discord !== undefined && typeof emoji.discord !== 'string') {
                    errors.push(`emojis[${index}].discord must be a string`);
                }
                if (emoji.guilded !== undefined && typeof emoji.guilded !== 'string') {
                    errors.push(`emojis[${index}].guilded must be a string`);
                }
                if (emoji.nerimity !== undefined && typeof emoji.nerimity !== 'string') {
                    errors.push(`emojis[${index}].nerimity must be a string`);
                }
                if (emoji.revolt !== undefined && typeof emoji.revolt !== 'string') {
                    errors.push(`emojis[${index}].revolt must be a string`);
                }
            }
        });
    }

    if (config.logs !== undefined && typeof config.logs !== 'object') {
        errors.push('logs must be a valid object');
    } else if (config.logs) {
        const logs = config.logs;
        if (logs.discord !== undefined && typeof logs.discord !== 'string') {
            errors.push('logs.discord must be a string');
        }
        if (logs.guilded !== undefined && typeof logs.guilded !== 'string') {
            errors.push('logs.guilded must be a string');
        }
        if (logs.nerimity !== undefined && typeof logs.nerimity !== 'string') {
            errors.push('logs.nerimity must be a string');
        }
        if (logs.revolt !== undefined && typeof logs.revolt !== 'string') {
            errors.push('logs.revolt must be a string');
        }
    }

    if (config.webhooks !== undefined && typeof config.webhooks !== 'object') {
        errors.push('webhooks must be a valid object');
    } else if (config.webhooks) {
        const webhooks = config.webhooks;
        if (webhooks.discord !== undefined && !Array.isArray(webhooks.discord)) {
            errors.push('webhooks.discord must be an array');
        }
        if (webhooks.guilded !== undefined && !Array.isArray(webhooks.guilded)) {
            errors.push('webhooks.guilded must be an array');
        }
        if (webhooks.nerimity !== undefined && !Array.isArray(webhooks.nerimity)) {
            errors.push('webhooks.nerimity must be an array');
        }
        if (webhooks.revolt !== undefined && !Array.isArray(webhooks.revolt)) {
            errors.push('webhooks.revolt must be an array');
        } else {
            if (webhooks.discord === undefined && webhooks.guilded === undefined && webhooks.nerimity === undefined && webhooks.revolt === undefined) {
                errors.push('At least one webhook type (discord, guilded, nerimity, revolt) must be defined.');
            }
        }
    }

    return errors.length === 0 ? false : errors;
}
