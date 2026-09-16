import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
console.log('Current directory:', process.cwd());
console.log('Env file path:', path.resolve(process.cwd(), '.env'));
console.log('Env file exists:', fs.existsSync(path.resolve(process.cwd(), '.env')));

const envPath = path.resolve(process.cwd(), '.env');
// Manual parsing fallback
if (!process.env.SUPABASE_URL && fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  console.log('Env content length:', envContent.length);
  
  envContent.split('\n').forEach(line => {
    // console.log('Line:', line); // Verify content if needed
    const match = line.match(/^\s*([\w_]+)\s*=\s*(.*)$/); // Improved regex
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim().replace(/^["'](.*)["']$/, '$1');
      console.log('Found key:', key);
      process.env[key] = value;
    }
  });
}

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

console.log('SUPABASE_URL present:', !!supabaseUrl);
console.log('SUPABASE_SERVICE_ROLE_KEY present:', !!supabaseKey);

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing env vars');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function fixMigration() {
  console.log('Attempting to delete conflicting migration record 20251227...');
  
  const { error } = await supabase
    .from('supabase_migrations.schema_migrations')
    .delete()
    .eq('version', '20251227');

  if (error) {
    console.error('Error deleting migration record:', error);
    // If table doesn't exist or we lack permissions, this will fail.
    // If it fails, we are stuck without raw SQL access.
  } else {
    console.log('Successfully deleted migration record 20251227');
  }
}

fixMigration();
