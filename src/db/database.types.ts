import type { Kysely } from "kysely";
import type { DB } from "./database.types.codegen.js";

export type ScripeDatabaseTables = DB;

export type Database = Kysely<ScripeDatabaseTables>;
export type DatabaseTransaction = Kysely<ScripeDatabaseTables>;