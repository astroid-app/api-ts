import * as fs from "fs";
const LOG_FOLDER = "logs";
const LOG_FILE = `${LOG_FOLDER}/astroidapi-${new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "")}.log`;

export function getLogFilePath(): string {
    return LOG_FILE;
}

async function writeLogToFile(entry: string) {
    if (!fs.existsSync(LOG_FOLDER)) {
        fs.mkdirSync(LOG_FOLDER, { recursive: true });
    }
    try {
        await fs.promises.appendFile(LOG_FILE, entry + "\n", { encoding: "utf8" });
    } catch (err) {
        // Fehler beim Schreiben ins Logfile ignorieren, aber in die Konsole ausgeben
        console.error("[LOGGING ERROR] Logger File Write Error:", err);
    }
}
const RESET = "\x1b[0m";
const COLORS = {
    INFO: "\x1b[36m",    // Cyan
    WARNING: "\x1b[33m", // Yellow
    ERROR: "\x1b[31m",   // Red
    DEBUG: "\x1b[35m",   // Magenta
    SUCCESS: "\x1b[32m", // Green
    LOG: "\x1b[34m",     // Blue
    API_REQUEST: "\x1b[38;5;208m", // Orange
};

function getTimestamp(): string {
    return new Date().toISOString();
}

function formatLog(level: "INFO" | "WARNING" | "ERROR" | "DEBUG" | "SUCCESS" | "LOG" | "API_REQUEST", message: string): { colored: string, plain: string } {
    const plain = `[${getTimestamp()}] [${level}] ${message}`;
    const colored = `${COLORS[level]}[${getTimestamp()}] [${level}]${RESET} ${message}`;
    return { colored, plain };
}

async function logInfo(message: string, traceback?: any) {
    const { colored, plain } = formatLog("INFO", message);
    console.log(colored);
    await writeLogToFile(plain);
    if (traceback) {
        const { colored: tbColored, plain: tbPlain } = formatLog("INFO", `${traceback}`);
        console.log(tbColored);
        await writeLogToFile(tbPlain);
    }
}

async function logWarning(message: string, traceback?: any) {
    const { colored, plain } = formatLog("WARNING", message);
    console.warn(colored);
    await writeLogToFile(plain);
    if (traceback) {
        const { colored: tbColored, plain: tbPlain } = formatLog("WARNING", `${traceback}`);
        console.warn(tbColored);
        await writeLogToFile(tbPlain);
    }
}

async function logError(message: string, traceback?: any) {
    const { colored, plain } = formatLog("ERROR", message);
    console.error(colored);
    await writeLogToFile(plain);
    if (traceback) {
        const { colored: tbColored, plain: tbPlain } = formatLog("ERROR", `${traceback}`);
        console.error(tbColored);
        await writeLogToFile(tbPlain);
    }
}

async function logDebug(message: string, traceback?: any) {
    const { colored, plain } = formatLog("DEBUG", message);
    console.debug(colored);
    await writeLogToFile(plain);
    if (traceback) {
        const { colored: tbColored, plain: tbPlain } = formatLog("DEBUG", `${traceback}`);
        console.debug(tbColored);
        await writeLogToFile(tbPlain);
    }
}

async function logSuccess(message: string, traceback?: any) {
    const { colored, plain } = formatLog("SUCCESS", message);
    console.log(colored);
    await writeLogToFile(plain);
    if (traceback) {
        const { colored: tbColored, plain: tbPlain } = formatLog("SUCCESS", `${traceback}`);
        console.log(tbColored);
        await writeLogToFile(tbPlain);
    }
}

async function logLog(message: string, traceback?: any) {
    const { colored, plain } = formatLog("LOG", message);
    console.log(colored);
    await writeLogToFile(plain);
    if (traceback) {
        const { colored: tbColored, plain: tbPlain } = formatLog("LOG", `${traceback}`);
        console.log(tbColored);
        await writeLogToFile(tbPlain);
    }
}

async function logApiRequest(message: string) {
    const { colored, plain } = formatLog("API_REQUEST", message);
    console.log(colored);
    await writeLogToFile(plain);
}

export default async function log(level: "INFO" | "WARN" | "ERROR" | "DEBUG" | "SUCCESS" | "LOG" | "API_REQUEST", message: string, error?: any) {
    switch (level) {
        case "INFO":
            await logInfo(message, error);
            break;
        case "WARN":
            await logWarning(message, error);
            break;
        case "ERROR":
            await logError(message, error);
            break;
        case "DEBUG":
            await logDebug(message, error);
            break;
        case "SUCCESS":
            await logSuccess(message, error);
            break;
        case "LOG":
            await logLog(message, error);
            break;
        case "API_REQUEST":
            await logApiRequest(message);
            break;
        default:
            await logLog("LOG", `Unknown log level: ${level}. Message: ${message}`);
    }
}