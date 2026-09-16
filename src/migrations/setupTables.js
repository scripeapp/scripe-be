// migrations/setupTables.js
const { createClient } = require("@supabase/supabase-js");
const dotenv = require("dotenv");

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// --------------------------------------------------------
// Helper: Run raw SQL via Supabase RPC
// --------------------------------------------------------
async function runSQL(sql) {
  const { error } = await supabase.rpc("exec_sql", { sql });
  if (error) throw error;
}

// --------------------------------------------------------
// Helper: Check if table exists
// --------------------------------------------------------
async function tableExists(name) {
  const { data, error } = await supabase
    .from("information_schema.tables")
    .select("table_name")
    .eq("table_schema", "public");

  if (error) throw error;
  return data.some((t) => t.table_name === name);
}

// --------------------------------------------------------
// Table Definitions
// --------------------------------------------------------
const TABLES = [
  {
    name: "organization_members",
    sql: `
      CREATE TABLE public.organization_members (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

        organization_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

        role TEXT NOT NULL CHECK (role IN ('admin', 'editor')),
        invited_by UUID REFERENCES auth.users(id),
        accepted BOOLEAN DEFAULT FALSE,

        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),

        UNIQUE (organization_id, user_id)
      );

      CREATE INDEX idx_org_members_org_id ON public.organization_members(organization_id);
      CREATE INDEX idx_org_members_user_id ON public.organization_members(user_id);
    `,
  },
];

// --------------------------------------------------------
// Migration Runner
// --------------------------------------------------------
async function createTables() {
  try {
    console.log("\n🔁 Starting database migration...\n");

    for (const table of TABLES) {
      const exists = await tableExists(table.name);

      if (!exists) {
        console.log(`🆕 Creating table: ${table.name}`);
        await runSQL(table.sql);
        console.log(`✅ Created: ${table.name}\n`);
      } else {
        console.log(`✔ Already exists: ${table.name}`);
      }
    }

    console.log("\n🎉 Database migration completed successfully!\n");
  } catch (err) {
    console.error("❌ Migration error:", err);
    throw err;
  }
}

// Run via: node migrations/setupTables.js
if (require.main === module) {
  createTables()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { createTables };
