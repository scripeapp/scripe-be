import 'dotenv/config';
import { supabase } from '../config/supabase';

async function checkEvents() {
  const { data: events, error } = await supabase
    .from('events')
    .select('id, event_name, status, end_date, business_id, owner_id');

  if (error) {
    console.error('Error fetching events:', error);
    return;
  }

  console.log('Total events:', events?.length);
  console.log('Events:', JSON.stringify(events, null, 2));

  // Check visibility for those events
  for (const event of events || []) {
    if (event.business_id) {
       const { data: b } = await supabase.from('businesses').select('marketplace_visibility').eq('id', event.business_id).single();
       console.log(`Event ${event.event_name} business ${event.business_id} visibility:`, b?.marketplace_visibility);
    } else {
       const { data: u } = await supabase.from('profiles').select('marketplace_visibility').eq('id', event.owner_id).single();
       console.log(`Event ${event.event_name} owner ${event.owner_id} visibility:`, u?.marketplace_visibility);
    }
  }
}

checkEvents();
