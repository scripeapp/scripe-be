import type { Kysely } from "kysely";
import type { DB } from "./database.types.codegen.js";

export type SurgeDatabaseTables = DB;

export type Database = Kysely<SurgeDatabaseTables>;
export type DatabaseTransaction = Kysely<SurgeDatabaseTables>;