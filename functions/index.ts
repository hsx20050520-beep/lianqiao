import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { serveSite } from './adapter.mjs';
import { handleRelay } from './relay.mjs';
import { storage } from './_qoder/storage.mjs';

Deno.serve(serveSite(
  ({ request, supabase }) => handleRelay({ request, supabase, storage, env: (name: string) => Deno.env.get(name) }),
  {
    createClient,
    env: (name: string) => Deno.env.get(name),
  },
));
