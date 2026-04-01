export interface Attachment {
	createdAt: Date,
	name: string,
	path: string,
	registeredPlatforms: string[],
	size: number,
	status: string,
	type: string
};