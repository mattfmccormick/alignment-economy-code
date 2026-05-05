// Single shared SDK client. Talks to /api/v1 in dev (Vite proxy forwards
// to localhost:3000) and to whatever VITE_API_URL is set to at build time.

import { AlignmentEconomyClient } from '@alignmenteconomy/sdk';

const baseUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api/v1';
export const client = new AlignmentEconomyClient({ baseUrl });
