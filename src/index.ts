import express = require("express");
import * as Sentry from "@sentry/node";
import * as dotenv from "dotenv";
import { NextFunction, Request, Response } from "express";
import * as fs from "fs";
import { getEndpoint } from "./GetEndpoint";
import { validateToken } from "./TokenHandler";
import {
	removeArrayItemFromConfig,
	updateEndpointConfig,
} from "./UpdateEndpointConfig";
import { validateConfig } from "./types/ConfigKeys";
import cors = require("cors");
import { roundStatistics } from "./statistics";

// Initialize dotenv
dotenv.config();
const MASTER_TOKEN = process.env.MASTER_TOKEN;
const SENTRY_DSN = process.env.SENTRY_DSN;

// Initialize Sentry
Sentry.init({
	dsn: SENTRY_DSN,
	tracesSampleRate: 1.0,
	profilesSampleRate: 1.0,
});

// Create Express app
const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// Logger middleware (can be replaced with other logging libraries)
app.use((req: Request, res: Response, next: NextFunction) => {
	console.info(`${req.method} ${req.url}`);
	next();
});

// Rate limiter middleware (implement actual logic as needed)
const rateLimiter = (req: Request, res: Response, next: NextFunction) => {
	// Rate limiting logic here
	next();
};
app.use(rateLimiter);

// CORS Middleware
app.use(
	cors({
		origin: "*",
		methods: ["GET", "POST", "PATCH", "DELETE"],
		credentials: true,
	})
);

// Utility function to read a file
const readFile = (filePath: string): Promise<string> =>
	new Promise((resolve, reject) => {
		fs.readFile(filePath, "utf8", (err, data) => {
			if (err) reject(err);
			else resolve(data);
		});
	});

// Routes
app.get("/viewlogs", async (req: Request, res: Response) => {
	const token = req.query.token as string;
	if (token === MASTER_TOKEN) {
		try {
			const logData = await readFile("astroidapi.log");
			res.type("text/plain").send(logData);
		} catch (err) {
			res.status(500).send("Error reading log file");
		}
	} else {
		res.status(404).send();
	}
});

app.get("/ga-test", (req: Request, res: Response) => {
	res.status(200).json({ commited: "210824-15" });
});

app.get("/docs", (req: Request, res: Response) => {
	res.redirect("https://docs.astroid.cc");
});

app.get("/", (req: Request, res: Response) => {
	const homeData = {
		heading: "Astroid API",
		description: "Astroid API for getting and modifying endpoints.",
		website: "https://astroid.cc",
		privacy: "https://astroid.cc/privacy",
		terms: "https://astroid.cc/terms",
		imprint: "https://astroid.cc/imprint",
		docs: "https://astroid.cc/docs",
		discord: "https://discord.gg/DbrFADj6Xw",
	};
	res.status(200).json(homeData);
});

app.get("/statistics", async (req: Request, res: Response): Promise<any> => {

	try {
		const stats = await roundStatistics();
		res.status(200).json(stats);
	} catch (err) {
		console.error(err);
		res.status(500).send({ message: "Internal Server Error", status: 500 });
	}
});

app.get("/:id", async (req: Request, res: Response): Promise<any> => {
	const endpointId = req.params.id;

	const token = req.query.token as string;
	if (!token) {
		return res
			.status(401)
			.send({ message: "Unauthorized: No token provided", status: 401 });
	}
	let isValidToken = await validateToken(endpointId, token);
	if (!isValidToken) {
		return res
			.status(401)
			.send({ message: "Unauthorized: Invalid token", status: 401 });
	}
	getEndpoint(endpointId)
		.then((endpoint) => {
			if (endpoint) {
				res.status(200).json(endpoint);
			} else {
				res.status(404).send({ message: "Endpoint not found", status: 404 });
			}
		})

		.catch((err) => {
			console.error(err);
			res.status(500).send({ message: "Internal Server Error", status: 500 });
		});
});

app.post("/:id/config", async (req: Request, res: Response): Promise<any> => {
	const endpointId = req.params.id;
	const token = req.query.token as string;
	if (!token) {
		return res
			.status(401)
			.send({ message: "Unauthorized: No token provided", status: 401 });
	}
	let isValidToken = await validateToken(endpointId, token);
	if (!isValidToken) {
		return res
			.status(401)
			.send({ message: "Unauthorized: Invalid token", status: 401 });
	}

	const newConfig = req.body;
	if (!newConfig) {
		return res
			.status(400)
			.send({ message: "Bad Request: No config provided", status: 400 });
	}

	const configIsValid = validateConfig(newConfig);
	if (configIsValid) {
		return res.status(400).send({
			message: "Bad Request: Invalid config",
			status: 400,
			details: configIsValid,
		});
	}

	try {
		const updatedConfig = await updateEndpointConfig(endpointId, newConfig);
		if (updatedConfig) {
			res.status(200).json(updatedConfig);
		} else {
			res.status(404).send({ message: "Endpoint not found", status: 404 });
		}
	} catch (err) {
		console.error(err);
		res.status(500).send({ message: "Internal Server Error", status: 500 });
	}
});


app.delete("/:id/config", async (req: Request, res: Response): Promise<any> => {
	const endpointId = req.params.id;
	const token = req.query.token as string;
	if (!token) {
		return res
			.status(401)
			.send({ message: "Unauthorized: No token provided", status: 401 });
	}
	let isValidToken = await validateToken(endpointId, token);
	if (!isValidToken) {
		return res
			.status(401)
			.send({ message: "Unauthorized: Invalid token", status: 401 });
	}
	const newConfig = req.body;
	if (!newConfig) {
		return res
			.status(400)
			.send({ message: "Bad Request: No config provided", status: 400 });
	}

	const configIsValid = validateConfig(newConfig);
	if (configIsValid) {
		return res.status(400).send({
			message: "Bad Request: Invalid config",
			status: 400,
			details: configIsValid,
		});
	}

	try {
		const updatedConfig = await removeArrayItemFromConfig(
			endpointId,
			newConfig
		);
		if (updatedConfig) {
			res.status(200).json(updatedConfig);
		} else {
			res.status(404).send({ message: "Endpoint not found", status: 404 });
		}
	} catch (err) {
		console.error(err);
		res.status(500).send({ message: "Internal Server Error", status: 500 });
	}
});

// Start the server
const PORT = 9921;
app.listen(PORT, () => {
	console.info(`Server listening at http://localhost:${PORT}`);
});
