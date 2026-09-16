
import { supabaseAdmin } from "../config/supabase";

const TARGET_PUB_ID = "e90260b6-7f3e-4355-9917-f3ce50b5ec50";

async function main() {
  console.log("--- Starting Optimised Bulk Subscription Script ---");
  console.log(`Target Publication ID: ${TARGET_PUB_ID}`);

  // 1. Verify Publication Exists
  const { data: publication, error: pubError } = await supabaseAdmin
    .from("publications")
    .select("id, name")
    .eq("id", TARGET_PUB_ID)
    .single();

  if (pubError || !publication) {
    console.error("❌ Critical: Target publication not found!", pubError);
    return;
  }
  console.log(`✅ Found Publication: ${publication.name}`);

  // 2. Fetch All Existing Subscriptions for this Pub
  console.log("Fetching existing subscriptions...");
  let existingUserIds = new Set<string>();
  let hasMoreSubs = true;
  let subPage = 0;
  const subPageSize = 1000;

  try {
      while (hasMoreSubs) {
            // Only need user_id to know who is already subscribed
            const { data: subs, error: subsError } = await supabaseAdmin
                .from("subscriptions")
                .select("user_id")
                .eq("publication_id", TARGET_PUB_ID)
                .range(subPage * subPageSize, (subPage + 1) * subPageSize - 1);
            
            // ... (rest unchanged)
            
            if (subs && subs.length > 0) {
                subs.forEach(s => existingUserIds.add(s.user_id));
                process.stdout.write(`\rFetched ${existingUserIds.size} existing subscriptions...`);
                subPage++;
            } else {
                hasMoreSubs = false;
            }
      }
      console.log(`\n✅ Total Existing Subscriptions: ${existingUserIds.size}`);

  } catch (err: any) {
  // ...
  }

  // 3. Fetch All Users
  console.log("Fetching all users to identify target audience...");
  
  let usersToSubscribe: { id: string }[] = [];
  let page = 0;
  const pageSize = 1000;
  let hasMoreUsers = true;
  let totalUsers = 0;

  try {
      while (hasMoreUsers) {
          const { data: users, error: usersError } = await supabaseAdmin
            .from("users")
            .select("id")
            .range(page * pageSize, (page + 1) * pageSize - 1);

          if (usersError) {
              throw new Error(usersError.message);
          }

          if (users && users.length > 0) {
              totalUsers += users.length;
              const newTargets = users.filter(u => !existingUserIds.has(u.id));
              usersToSubscribe.push(...newTargets);
              
              process.stdout.write(`\rScanned ${totalUsers} users. Identified ${usersToSubscribe.length} needing subscription...`);
              page++;
          } else {
              hasMoreUsers = false;
          }
      }
      console.log(`\n✅ Scan Complete. Users needing subscription: ${usersToSubscribe.length}`);

  } catch (err: any) {
      console.error("\n❌ Error fetching users:", err.message);
      return;
  }

  if (usersToSubscribe.length === 0) {
      console.log("All users are already subscribed. Exiting.");
      return;
  }

  // 4. Batch Insert Subscriptions
  console.log("Starting batch insertion...");
  
  const BATCH_SIZE = 500;
  let processed = 0;
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < usersToSubscribe.length; i += BATCH_SIZE) {
      const batch = usersToSubscribe.slice(i, i + BATCH_SIZE);
      
      const subscriptions = batch.map(user => ({
          user_id: user.id,
          publication_id: TARGET_PUB_ID,
          subscription_type: "free",
          status: "active",
          subscribed_at: new Date().toISOString()
      }));

      const { data, error } = await supabaseAdmin
          .from("subscriptions")
          .insert(subscriptions)
          .select("id"); // Select IDs just to confirm insertion count

      processed += batch.length;

      if (error) {
          console.error(`\n❌ Batch Error (Offset ${i}):`, error.message);
          failCount += batch.length;
          // In a real migration we might want to retry or log specific IDs, 
          // but for now we log the batch block failure.
      } else {
          successCount += (data?.length || 0);
          const percent = Math.round((processed / usersToSubscribe.length) * 100);
          process.stdout.write(`\rProgress: ${processed}/${usersToSubscribe.length} (${percent}%) | Success: ${successCount} | Failed: ${failCount}`);
      }
      
      // Small pause to be nice to the DB
      await new Promise(resolve => setTimeout(resolve, 50));
  }

  console.log("\n\n--- Execution Summary ---");
  console.log(`Total Users Processed: ${usersToSubscribe.length}`);
  console.log(`✅ Successfully Subscribed: ${successCount}`);
  console.log(`❌ Failed: ${failCount}`);
  console.log("-------------------------");
}

main().catch((err) => console.error("Fatal Script Error:", err));
