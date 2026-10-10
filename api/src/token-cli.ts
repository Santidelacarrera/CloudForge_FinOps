// Dev helper: JWT_SECRET=... npm run token -- <user> <org> <role,role>
import { signJwt } from './auth';
const [sub, org, roles] = process.argv.slice(2);
if (!process.env.JWT_SECRET || !sub || !org) { console.error('usage: JWT_SECRET=... token <user> <org> <roles>'); process.exit(1); }
console.log(signJwt({ sub, org, roles: (roles ?? '').split(',').filter(Boolean) }, process.env.JWT_SECRET));
