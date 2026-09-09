/**
 * Account management, the replacement for editing an htpasswd file.
 *
 *   pnpm user list
 *   pnpm user add john@smith.com [password]
 *   pnpm user password john@smith.com [password]
 *   pnpm user remove john@smith.com
 *
 * The name can be an email address or a plain username — `newsroom`, say. The
 * app never mails an account holder, so nothing depends on it being routable.
 *
 * Omit the password and one is generated and printed. Both `add` and `password`
 * mark it temporary: the person is made to choose their own the first time they
 * sign in, so the one you read out over the phone stops working immediately.
 */

import { client } from '@/db';
import {
  addUser,
  findUser,
  listUsers,
  normalizeEmail,
  removeUser,
  resetPassword,
  suggestPassword,
} from '@/lib/gate';

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * The name someone signs in with.
 *
 * An email address is the usual choice and stays the suggestion, but nothing
 * here needs one: the app sends no mail to an account holder, and a password
 * is handed over by whoever runs the instance. So this checks only what would
 * break — an empty name, whitespace inside one, or a control character, none
 * of which anyone can type into the sign-in box and match. The request form
 * under /api/gate/request still demands a real address, because that one is
 * handed to the mailer as a reply-to.
 */
function requireAccount(raw: string | undefined): string {
  if (!raw) die('Which account? e.g. pnpm user add john@smith.com');
  const name = normalizeEmail(raw);
  if (name.length < 3) die(`"${raw}" is too short — three characters or more.`);
  if (name.length > 200) die(`"${raw}" is too long — 200 characters at most.`);
  if (/[\s\u0000-\u001f\u007f]/.test(name)) {
    die(`"${raw}" cannot contain spaces or control characters.`);
  }
  return name;
}

function announce(email: string, password: string, verb: string): void {
  console.log(`\n${verb} ${email}`);
  console.log(`  temporary password: ${password}`);
  console.log('\nThey will be asked to choose their own the first time they sign in.\n');
}

async function main() {
  const [command, emailArg, passwordArg] = process.argv.slice(2);

  switch (command) {
    case 'list': {
      const rows = await listUsers();
      if (rows.length === 0) {
        console.log('No accounts yet. Add one: pnpm user add you@example.com');
        break;
      }
      for (const r of rows) {
        const seen = r.lastSignInAt
          ? `last signed in ${r.lastSignInAt.toISOString().slice(0, 10)}`
          : 'never signed in';
        const flag = r.mustChangePassword ? ' · temporary password' : '';
        console.log(`${r.email}  (${seen}${flag})`);
      }
      break;
    }

    case 'add': {
      const email = requireAccount(emailArg);
      if (await findUser(email)) die(`${email} already has an account.`);
      const password = passwordArg || suggestPassword();
      await addUser(email, password);
      announce(email, password, 'Added');
      break;
    }

    case 'password': {
      const email = requireAccount(emailArg);
      const password = passwordArg || suggestPassword();
      if (!(await resetPassword(email, password))) die(`No account for ${email}.`);
      announce(email, password, 'Reset');
      break;
    }

    case 'remove': {
      const email = requireAccount(emailArg);
      if (!(await removeUser(email))) die(`No account for ${email}.`);
      console.log(`Removed ${email}. Their sessions stop working immediately.`);
      break;
    }

    default:
      die('Usage: pnpm user <list|add|password|remove> [email or username] [password]');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => client.end());
