import { RecordId } from "surrealdb";

export interface Token {
    tokens: string[];
    id?: RecordId;
}