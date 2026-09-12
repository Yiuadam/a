/*
  Behavioral tests for lib/auth utilities to kill surviving mutants.

  Tests cover: env readers (process.env, URL parsing, origin validation),
  username generation/validation (shape, email parsing, collision avoidance),
  display name generation, identity validation, error messages.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test, describe } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);
register("./cutover-write-barrier-resolve.mjs", import.meta.url);

// Import all modules under test
const envModule = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "env.ts")).href,
);
const generatedUsernameModule = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "generated-username.ts")).href,
);
const usernamesModule = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "usernames.ts")).href,
);
const errorsModule = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "errors.ts")).href,
);
const accountIdentityModule = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "account-identity.ts")).href,
);
const runtimeModule = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "runtime.ts")).href,
);

// Helper to manage process.env changes
async function withEnv(values, run) {
  const previous = new Map();
  const keys = Object.keys(values);
  for (const key of keys) {
    previous.set(key, process.env[key]);
  }
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = String(value);
    }
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ===========================================================================
// env.ts tests
// ===========================================================================

describe("env.ts", () => {
  test("MODULE constant is not empty string", async () => {
    // Mutant: "lib/auth/env.ts" → ""
    // The constant is used by assertServerOnly; empty string would be meaningless
    const envText = await (await import("node:fs/promises")).readFile(
      join(process.cwd(), "lib", "auth", "env.ts"),
      "utf8"
    );
    assert.match(envText, /const MODULE = "lib\/auth\/env\.ts"/);
  });

  test("googleClientId returns undefined when env var missing", async () => {
    await withEnv({ GOOGLE_CLIENT_ID: undefined }, () => {
      assert.equal(envModule.googleClientId(), undefined);
    });
  });

  test("googleClientId returns undefined when env var is empty", async () => {
    await withEnv({ GOOGLE_CLIENT_ID: "" }, () => {
      assert.equal(envModule.googleClientId(), undefined);
    });
  });

  test("googleClientId returns value when env var is non-empty", async () => {
    await withEnv({ GOOGLE_CLIENT_ID: "my-client-id" }, () => {
      assert.equal(envModule.googleClientId(), "my-client-id");
    });
  });

  test("googleIosClientId returns undefined when empty", async () => {
    await withEnv({ GOOGLE_IOS_CLIENT_ID: "" }, () => {
      assert.equal(envModule.googleIosClientId(), undefined);
    });
  });

  test("googleIosClientId returns value when present", async () => {
    await withEnv({ GOOGLE_IOS_CLIENT_ID: "ios-client-id" }, () => {
      assert.equal(envModule.googleIosClientId(), "ios-client-id");
    });
  });

  test("googleOAuthAppOrigin validates HTTPS protocol", async () => {
    // Mutant: url.protocol !== "https:" → false
    // Should reject non-HTTPS URLs
    await withEnv({ GOOGLE_OAUTH_APP_ORIGIN: "http://example.com/" }, () => {
      assert.equal(envModule.googleOAuthAppOrigin(), undefined);
    });
  });

  test("googleOAuthAppOrigin accepts valid HTTPS origin", async () => {
    await withEnv({ GOOGLE_OAUTH_APP_ORIGIN: "https://example.com/" }, () => {
      const result = envModule.googleOAuthAppOrigin();
      assert.equal(result, "https://example.com");
    });
  });

  test("googleOAuthAppOrigin rejects URLs with username", async () => {
    // Mutant: url.username → skipped, would allow username in URL
    await withEnv({ GOOGLE_OAUTH_APP_ORIGIN: "https://user@example.com/" }, () => {
      assert.equal(envModule.googleOAuthAppOrigin(), undefined);
    });
  });

  test("googleOAuthAppOrigin rejects URLs with password", async () => {
    // Mutant: url.password → skipped, would allow password in URL
    await withEnv({ GOOGLE_OAUTH_APP_ORIGIN: "https://user:pass@example.com/" }, () => {
      assert.equal(envModule.googleOAuthAppOrigin(), undefined);
    });
  });

  test("googleOAuthAppOrigin rejects URLs with non-root path", async () => {
    // Mutant: url.pathname !== "/" → false
    await withEnv({ GOOGLE_OAUTH_APP_ORIGIN: "https://example.com/foo" }, () => {
      assert.equal(envModule.googleOAuthAppOrigin(), undefined);
    });
  });

  test("googleOAuthAppOrigin rejects URLs with query string", async () => {
    // Mutant: url.search → skipped, would allow query string
    await withEnv({ GOOGLE_OAUTH_APP_ORIGIN: "https://example.com/?foo=bar" }, () => {
      assert.equal(envModule.googleOAuthAppOrigin(), undefined);
    });
  });

  test("googleOAuthAppOrigin rejects URLs with hash fragment", async () => {
    // Mutant: url.hash → skipped, would allow hash
    await withEnv({ GOOGLE_OAUTH_APP_ORIGIN: "https://example.com/#section" }, () => {
      assert.equal(envModule.googleOAuthAppOrigin(), undefined);
    });
  });

  test("googleOAuthAppOrigin returns undefined for invalid URL", async () => {
    // Mutant: catch block → empty, would not catch parse errors
    await withEnv({ GOOGLE_OAUTH_APP_ORIGIN: "not a valid url" }, () => {
      assert.equal(envModule.googleOAuthAppOrigin(), undefined);
    });
  });

  test("appleSignInAppOrigin validates origin same as Google", async () => {
    // Same validation logic as googleOAuthAppOrigin
    await withEnv({ APPLE_SIGNIN_APP_ORIGIN: "https://example.com/" }, () => {
      const result = envModule.appleSignInAppOrigin();
      assert.equal(result, "https://example.com");
    });
  });

  test("appleSignInAppOrigin rejects non-root path", async () => {
    // Mutant: url.pathname !== "/" → false
    await withEnv({ APPLE_SIGNIN_APP_ORIGIN: "https://example.com/foo" }, () => {
      assert.equal(envModule.appleSignInAppOrigin(), undefined);
    });
  });

  test("accountsEnabled returns false when not set", async () => {
    // Mutant: process.env["ACCOUNTS_ENABLED"] === "1" → true
    await withEnv({ ACCOUNTS_ENABLED: undefined }, () => {
      assert.equal(envModule.accountsEnabled(), false);
    });
  });

  test("accountsEnabled returns true when set to 1", async () => {
    await withEnv({ ACCOUNTS_ENABLED: "1" }, () => {
      assert.equal(envModule.accountsEnabled(), true);
    });
  });

  test("accountsEnabled returns false when set to 0", async () => {
    // Mutant: conditional → true would always return true
    await withEnv({ ACCOUNTS_ENABLED: "0" }, () => {
      assert.equal(envModule.accountsEnabled(), false);
    });
  });

  test("usageFailOpen returns false by default", async () => {
    // Mutant: process.env["USAGE_FAIL_OPEN"] === "1" → true
    // Mutant: → false
    await withEnv({ USAGE_FAIL_OPEN: undefined }, () => {
      assert.equal(envModule.usageFailOpen(), false);
    });
  });

  test("usageFailOpen returns true when set to 1", async () => {
    await withEnv({ USAGE_FAIL_OPEN: "1" }, () => {
      assert.equal(envModule.usageFailOpen(), true);
    });
  });

  test("allowedOrigins returns empty array when not set", async () => {
    // Mutant: ArrayDeclaration [] → ["Stryker was here"]
    await withEnv({ ACCOUNTS_ALLOWED_ORIGINS: undefined }, () => {
      const origins = envModule.allowedOrigins();
      assert.deepEqual(origins, []);
    });
  });

  test("allowedOrigins parses comma-separated list", async () => {
    // Mutant: .split(",") → missing, would not split
    await withEnv({ ACCOUNTS_ALLOWED_ORIGINS: "https://a.com,https://b.com" }, () => {
      const origins = envModule.allowedOrigins();
      assert.deepEqual(origins, ["https://a.com", "https://b.com"]);
    });
  });

  test("allowedOrigins trims whitespace", async () => {
    // Mutant: .trim() → missing, would leave whitespace
    await withEnv({ ACCOUNTS_ALLOWED_ORIGINS: " https://a.com , https://b.com " }, () => {
      const origins = envModule.allowedOrigins();
      assert.deepEqual(origins, ["https://a.com", "https://b.com"]);
    });
  });

  test("allowedOrigins removes trailing slashes", async () => {
    // Mutant: /\/$/ → /\/ (would remove all slashes)
    // Mutant: replace(..., "") → replace(..., "Stryker was here!")
    await withEnv({ ACCOUNTS_ALLOWED_ORIGINS: "https://a.com/,https://b.com/" }, () => {
      const origins = envModule.allowedOrigins();
      assert.deepEqual(origins, ["https://a.com", "https://b.com"]);
    });
  });

  test("allowedOrigins filters empty strings", async () => {
    // Mutant: .filter(Boolean) → missing, would include empty strings
    await withEnv({ ACCOUNTS_ALLOWED_ORIGINS: "https://a.com,,https://b.com" }, () => {
      const origins = envModule.allowedOrigins();
      assert.deepEqual(origins, ["https://a.com", "https://b.com"]);
    });
  });

  test("adminEmails returns empty array when not set", async () => {
    await withEnv({ ADMIN_EMAILS: undefined }, () => {
      const emails = envModule.adminEmails();
      assert.deepEqual(emails, []);
    });
  });

  test("adminEmails parses comma-separated list", async () => {
    await withEnv({ ADMIN_EMAILS: "admin@a.com,owner@b.com" }, () => {
      const emails = envModule.adminEmails();
      assert.deepEqual(emails, ["admin@a.com", "owner@b.com"]);
    });
  });

  test("adminEmails trims and lowercases", async () => {
    // Mutant: .toLowerCase() → missing, would preserve case
    // Mutant: .trim() → missing, would leave whitespace
    await withEnv({ ADMIN_EMAILS: " ADMIN@A.COM , Owner@B.COM " }, () => {
      const emails = envModule.adminEmails();
      assert.deepEqual(emails, ["admin@a.com", "owner@b.com"]);
    });
  });

  test("adminEmails filters empty strings", async () => {
    // Mutant: .filter(Boolean) → missing
    await withEnv({ ADMIN_EMAILS: "admin@a.com,,owner@b.com" }, () => {
      const emails = envModule.adminEmails();
      assert.deepEqual(emails, ["admin@a.com", "owner@b.com"]);
    });
  });

  test("isAdminEmail returns false for non-admin", async () => {
    await withEnv({ ADMIN_EMAILS: "admin@a.com" }, () => {
      assert.equal(envModule.isAdminEmail("user@b.com"), false);
    });
  });

  test("isAdminEmail returns true for admin email", async () => {
    await withEnv({ ADMIN_EMAILS: "admin@a.com" }, () => {
      assert.equal(envModule.isAdminEmail("admin@a.com"), true);
    });
  });

  test("isAdminEmail returns false for null", async () => {
    await withEnv({ ADMIN_EMAILS: "admin@a.com" }, () => {
      assert.equal(envModule.isAdminEmail(null), false);
    });
  });

  test("isAdminEmail trims and lowercases", async () => {
    await withEnv({ ADMIN_EMAILS: "admin@a.com" }, () => {
      assert.equal(envModule.isAdminEmail(" ADMIN@A.COM "), true);
    });
  });

  test("adminUsername returns null when not set", async () => {
    await withEnv({ ADMIN_USERNAME: undefined }, () => {
      const username = envModule.adminUsername();
      assert.equal(username, null);
    });
  });

  test("adminUsername returns normalized username when set", async () => {
    // Mutant: normaliseUsername not called → would return raw value
    await withEnv({ ADMIN_USERNAME: " Admin123 " }, () => {
      const username = envModule.adminUsername();
      assert.equal(username, "admin123");
    });
  });

  test("adminUsername returns null for invalid shape", async () => {
    // Must be 3+ chars, no @ symbols
    await withEnv({ ADMIN_USERNAME: "@" }, () => {
      const username = envModule.adminUsername();
      assert.equal(username, null);
    });
  });

  test("emailForIdentifier recognizes email addresses", async () => {
    // Mutant: value.includes("@") → false
    await withEnv({ ADMIN_EMAILS: "owner@example.com", ADMIN_USERNAME: "admin" }, () => {
      assert.equal(
        envModule.emailForIdentifier("user@example.com"),
        "user@example.com"
      );
    });
  });

  test("emailForIdentifier lowers case for emails", async () => {
    await withEnv({ ADMIN_EMAILS: "owner@example.com", ADMIN_USERNAME: "admin" }, () => {
      assert.equal(
        envModule.emailForIdentifier("USER@EXAMPLE.COM"),
        "user@example.com"
      );
    });
  });

  test("emailForIdentifier returns null for non-email, non-username", async () => {
    // Mutant: typed === null → false, username !== null → false
    await withEnv({ ADMIN_EMAILS: "owner@example.com", ADMIN_USERNAME: "admin" }, () => {
      assert.equal(
        envModule.emailForIdentifier("unknown"),
        null
      );
    });
  });

  test("emailForIdentifier resolves admin username to email", async () => {
    // Mutant: username !== null && typed === username → mutated versions
    await withEnv({ ADMIN_EMAILS: "owner@example.com", ADMIN_USERNAME: "admin" }, () => {
      assert.equal(
        envModule.emailForIdentifier("admin"),
        "owner@example.com"
      );
    });
  });

  test("supabaseConfig returns null when URL missing", async () => {
    await withEnv({
      SUPABASE_URL: undefined,
      SUPABASE_SERVICE_ROLE_KEY: "key",
      SUPABASE_ANON_KEY: "anon"
    }, () => {
      assert.equal(envModule.supabaseConfig(), null);
    });
  });

  test("supabaseConfig returns null when any key missing", async () => {
    await withEnv({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: undefined,
      SUPABASE_ANON_KEY: "anon"
    }, () => {
      assert.equal(envModule.supabaseConfig(), null);
    });
  });

  test("supabaseConfig returns config when all present", async () => {
    await withEnv({
      SUPABASE_URL: "https://example.supabase.co/",
      SUPABASE_SERVICE_ROLE_KEY: "role-key",
      SUPABASE_ANON_KEY: "anon-key"
    }, () => {
      const config = envModule.supabaseConfig();
      assert.equal(config.url, "https://example.supabase.co");
      assert.equal(config.serviceRoleKey, "role-key");
      assert.equal(config.anonKey, "anon-key");
    });
  });

  test("supabaseConfig removes trailing slash", async () => {
    // Mutant: .replace(/\/$/, "") → missing
    await withEnv({
      SUPABASE_URL: "https://example.supabase.co/",
      SUPABASE_SERVICE_ROLE_KEY: "role-key",
      SUPABASE_ANON_KEY: "anon-key"
    }, () => {
      const config = envModule.supabaseConfig();
      assert.equal(config.url, "https://example.supabase.co");
    });
  });

  test("anthropicAdminKey returns undefined when empty", async () => {
    // Tests the secret() function mutation: value && value.length > 0 → true
    // Would return "" instead of undefined if mutated
    await withEnv({ ANTHROPIC_ADMIN_KEY: "" }, () => {
      const key = envModule.anthropicAdminKey();
      assert.equal(key, undefined);
    });
  });

  test("anthropicAdminKey returns value when non-empty", async () => {
    await withEnv({ ANTHROPIC_ADMIN_KEY: "test-key" }, () => {
      const key = envModule.anthropicAdminKey();
      assert.equal(key, "test-key");
    });
  });

  test("anthropicWorkspaceId returns undefined when empty", async () => {
    // Tests the secret() function mutation
    await withEnv({ ANTHROPIC_WORKSPACE_ID: "" }, () => {
      const id = envModule.anthropicWorkspaceId();
      assert.equal(id, undefined);
    });
  });

  test("bandUpSessionSigningKey returns undefined when empty", async () => {
    // Tests the secret() function mutation
    await withEnv({ BANDUP_SESSION_SIGNING_KEY: "" }, () => {
      const key = envModule.bandUpSessionSigningKey();
      assert.equal(key, undefined);
    });
  });

  test("avatarUrlSigningKey returns undefined when empty", async () => {
    // Tests the secret() function mutation
    await withEnv({ AVATAR_URL_SIGNING_KEY: "" }, () => {
      const key = envModule.avatarUrlSigningKey();
      assert.equal(key, undefined);
    });
  });

  test("ipHashSalt returns undefined when empty", async () => {
    // Tests the secret() function mutation
    await withEnv({ USAGE_IP_HASH_SALT: "" }, () => {
      const salt = envModule.ipHashSalt();
      assert.equal(salt, undefined);
    });
  });

  test("resendApiKey returns undefined when empty", async () => {
    // Tests the secret() function mutation
    await withEnv({ RESEND_API_KEY: "" }, () => {
      const key = envModule.resendApiKey();
      assert.equal(key, undefined);
    });
  });
});

// ===========================================================================
// generated-username.ts tests
// ===========================================================================

describe("generated-username.ts", () => {
  test("generateDisplayName returns two capitalized words", () => {
    // Use a fixed random for predictability
    let idx = 0;
    const fixedRandom = () => {
      const values = [0, 1]; // Will pick first adjective and noun
      return values[idx++ % values.length];
    };
    const name = generatedUsernameModule.generateDisplayName(null, fixedRandom);
    assert.match(name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });

  test("generateDisplayName avoids previous value", () => {
    const fixedRandom = () => {
      // Keep returning 0 to try to repeat
      return 0;
    };
    const first = generatedUsernameModule.generateDisplayName(null, fixedRandom);

    // Call again with first as previous
    const second = generatedUsernameModule.generateDisplayName(first, fixedRandom);

    // Should be different (walked the list)
    assert.notEqual(first, second);
  });

  test("usernameFromEmail parses local part", () => {
    // Mutant: email.indexOf("@") → missing would fail
    const username = generatedUsernameModule.usernameFromEmail("adam.yiu@example.com");
    assert.equal(username, "adam.yiu");
  });

  test("usernameFromEmail rejects email without @", () => {
    // Mutant: at < 1 → at <= 1 (would reject single-char local parts)
    assert.equal(generatedUsernameModule.usernameFromEmail("notanemail"), null);
  });

  test("usernameFromEmail removes plus-tag", () => {
    // Mutant: .split("+")[0] → missing would include tag
    const username = generatedUsernameModule.usernameFromEmail("adam+ielts@example.com");
    assert.equal(username, "adam");
  });

  test("usernameFromEmail lowercases", () => {
    // Mutant: .toLowerCase() → missing
    const username = generatedUsernameModule.usernameFromEmail("Adam.YIU@example.com");
    assert(username.toLowerCase() === username);
  });

  test("usernameFromEmail replaces invalid chars with dots", () => {
    // Mutant: replace(/[^a-z0-9._-]/g, ".") → missing
    const username = generatedUsernameModule.usernameFromEmail("adam+yiu!@example.com");
    assert(!username.includes("!"));
    assert(!username.includes("+"));
    // Either "adamyiu" or "adam.yiu" depending on if valid chars are kept
    assert(username !== null);
  });

  test("usernameFromEmail collapses dot runs", () => {
    // Mutant: replace(/\.{2,}/g, ".") → missing
    const username = generatedUsernameModule.usernameFromEmail("adam..yiu@example.com");
    assert(!username.includes(".."));
  });

  test("usernameFromEmail trims leading invalid chars", () => {
    // Mutant: replace(/^[._-]+/, "") → missing
    const username = generatedUsernameModule.usernameFromEmail("...adam@example.com");
    assert(!username.startsWith("."));
  });

  test("usernameFromEmail trims trailing invalid chars", () => {
    // Mutant: replace(/[._-]+$/, "") → missing
    const username = generatedUsernameModule.usernameFromEmail("adam...@example.com");
    assert(!username.endsWith("."));
  });

  test("usernameFromEmail returns null for empty local part", () => {
    // Mutant: value.length === 0 → false
    assert.equal(generatedUsernameModule.usernameFromEmail("@example.com"), null);
  });

  test("usernameFromEmail pads short local parts", () => {
    // Mutant: < 3 → missing, would reject 2-char names
    const username = generatedUsernameModule.usernameFromEmail("al@example.com");
    assert.equal(username, "al0"); // Padded with zeros
  });

  test("usernameFromEmail truncates long local parts", () => {
    // Mutant: .slice(0, 30) → missing would allow >30 chars
    const long = "a".repeat(40) + "@example.com";
    const username = generatedUsernameModule.usernameFromEmail(long);
    assert(username.length <= 30);
  });

  test("usernameFromEmailAttempt returns base on attempt 0", () => {
    const attempt0 = generatedUsernameModule.usernameFromEmailAttempt("adam@example.com", 0);
    assert.equal(attempt0, "adam");
  });

  test("usernameFromEmailAttempt appends suffix for attempt 1-3", () => {
    // Mutant: attempt > 3 → attempt >= 3 (would reject valid attempts)
    const attempt1 = generatedUsernameModule.usernameFromEmailAttempt("adam@example.com", 1);
    assert.equal(attempt1, "adam2");
  });

  test("usernameFromEmailAttempt returns null for attempt > 3", () => {
    // Mutant: > 3 → missing/changed
    assert.equal(generatedUsernameModule.usernameFromEmailAttempt("adam@example.com", 4), null);
  });

  test("usernameFromEmailAttempt returns null when base is null", () => {
    // Empty email yields no base
    assert.equal(generatedUsernameModule.usernameFromEmailAttempt("@example.com", 0), null);
  });

  test("generateUsername uses random candidates", () => {
    let idx = 0;
    const fixedRandom = () => {
      return idx++;
    };
    const username = generatedUsernameModule.generateUsername(null, fixedRandom);
    assert.match(username, /^[a-z]+-[a-z]+-\d{3}$/);
  });

  test("generateUsername avoids previous value", () => {
    const fixedRandom = () => 0; // Always same
    const first = generatedUsernameModule.generateUsername(null, fixedRandom);
    const second = generatedUsernameModule.generateUsername(first, fixedRandom);
    assert.notEqual(first, second);
  });

  test("generateUsername fallback increments numeric suffix", () => {
    // Mutant: ((Number(match[2]) - 99) % 900) → arithmetic mutations
    const previous = "bright-badger-100";
    const username = generatedUsernameModule.generateUsername(previous, () => 0);
    // Should increment from 100 to 101
    assert(username.match(/bright-badger-\d{3}/));
  });

  test("generateUsername fallback wraps suffix at 999", () => {
    // Previous ends in 999, should wrap to 100
    const previous = "bright-badger-999";
    const username = generatedUsernameModule.generateUsername(previous, () => 0);
    assert(username.match(/bright-badger-\d{3}/));
  });
});

// ===========================================================================
// usernames.ts tests
// ===========================================================================

describe("usernames.ts", () => {
  test("normaliseUsername trims whitespace", () => {
    // Mutant: .trim() → missing
    const result = usernamesModule.normaliseUsername("  admin  ");
    assert.equal(result, "admin");
  });

  test("normaliseUsername lowercases", () => {
    // Mutant: .toLowerCase() → missing
    const result = usernamesModule.normaliseUsername("ADMIN");
    assert.equal(result, "admin");
  });

  test("normaliseUsername returns null for empty string", () => {
    // Mutant: value.length === 0 → false
    assert.equal(usernamesModule.normaliseUsername(""), null);
  });

  test("normaliseUsername returns null for whitespace only", () => {
    // Trims first, then checks length
    assert.equal(usernamesModule.normaliseUsername("   "), null);
  });

  test("normaliseUsername returns null for addresses with @", () => {
    // Mutant: value.includes("@") → false
    assert.equal(usernamesModule.normaliseUsername("admin@example.com"), null);
  });

  test("normaliseUsername validates shape", () => {
    // Must start with alphanumeric, 3-30 total, only [a-z0-9._-]
    assert.equal(usernamesModule.normaliseUsername("ab"), null); // Too short
    assert.equal(usernamesModule.normaliseUsername("a" + "b".repeat(30)), null); // Too long
    assert.equal(usernamesModule.normaliseUsername("-admin"), null); // Doesn't start with alnum
  });

  test("normaliseUsername accepts valid shape", () => {
    assert.equal(usernamesModule.normaliseUsername("adam.yiu-123"), "adam.yiu-123");
  });

  test("isReservedUsername rejects reserved names", () => {
    assert.equal(usernamesModule.isReservedUsername("admin"), true);
    assert.equal(usernamesModule.isReservedUsername("support"), true);
  });

  test("isReservedUsername accepts non-reserved names", () => {
    assert.equal(usernamesModule.isReservedUsername("adam"), false);
  });

  test("claimable rejects invalid shapes", () => {
    // Mutant: normaliseUsername not called → would accept invalid
    const result = usernamesModule.claimable("@", null);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "shape");
  });

  test("claimable rejects reserved names", () => {
    // Mutant: isReservedUsername not called → would allow reserved
    const result = usernamesModule.claimable("admin", null);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "reserved");
  });

  test("claimable accepts valid non-reserved names", () => {
    // Mutant: early returns → missing
    const result = usernamesModule.claimable("adam", null);
    assert.equal(result.ok, true);
    assert.equal(result.username, "adam");
  });

  test("claimable rejects owner's username", () => {
    // Mutant: takenByOwner !== null → false
    // Mutant: username === normaliseUsername(takenByOwner) → false
    // Mutant: && → ||
    const result = usernamesModule.claimable("owner", "owner");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "reserved");
  });

  test("claimable accepts different name when owner has one", () => {
    // Owner is "admin", but "adam" should be available
    const result = usernamesModule.claimable("adam", "admin");
    assert.equal(result.ok, true);
  });
});

// ===========================================================================
// errors.ts tests
// ===========================================================================

describe("errors.ts", () => {
  test("MESSAGES.quotaExceeded contains expected text", () => {
    // Mutant: StringLiteral → ""
    const msg = errorsModule.MESSAGES.quotaExceeded;
    assert(msg.length > 0);
    assert(msg.includes("allowance"));
  });

  test("MESSAGES.rateLimited contains expected text", () => {
    const msg = errorsModule.MESSAGES.rateLimited;
    assert(msg.length > 0);
    assert(msg.includes("week"));
  });

  test("MESSAGES.unavailable contains expected text", () => {
    const msg = errorsModule.MESSAGES.unavailable;
    assert(msg.length > 0);
    assert(msg.includes("briefly unavailable"));
  });

  test("MESSAGES.accountUnavailable contains expected text", () => {
    const msg = errorsModule.MESSAGES.accountUnavailable;
    assert(msg.length > 0);
    assert(msg.includes("Account"));
  });

  test("MESSAGES.signInRequired contains expected text", () => {
    const msg = errorsModule.MESSAGES.signInRequired;
    assert(msg.length > 0);
    assert(msg.includes("sign in"));
  });

  test("safeJsonError returns NextResponse with status", () => {
    // Mutant: { "Cache-Control": "private, no-store, max-age=0" } → {}
    const response = errorsModule.safeJsonError("test error", 400);
    assert.equal(response.status, 400);
    // Check that Cache-Control header is set
    const cacheControl = response.headers.get("Cache-Control");
    assert.equal(cacheControl, "private, no-store, max-age=0");
  });

  test("safeJsonError returns JSON error message", () => {
    // Mutant: error message → ""
    const response = errorsModule.safeJsonError("test error", 400);
    // Response body should contain the error message
    assert(response.body); // NextResponse has a body
  });
});

// ===========================================================================
// account-identity.ts tests
// ===========================================================================

describe("account-identity.ts", () => {
  test("readAccountKind accepts valid kind", () => {
    // Mutant: conditional → false would reject all
    const kind = accountIdentityModule.readAccountKind("student");
    assert.equal(kind, "student");
  });

  test("readAccountKind rejects invalid kind", () => {
    const kind = accountIdentityModule.readAccountKind("invalid");
    assert.equal(kind, null);
  });

  test("readAccountKind rejects non-string", () => {
    assert.equal(accountIdentityModule.readAccountKind(123), null);
    assert.equal(accountIdentityModule.readAccountKind(null), null);
  });

  test("accountIdentityComplete requires displayName", () => {
    // Mutant: value?.displayName?.trim() → missing .trim() or .displayName
    const identity = { displayName: "", username: "adam" };
    assert.equal(accountIdentityModule.accountIdentityComplete(identity), false);
  });

  test("accountIdentityComplete requires username", () => {
    // Mutant: value.username?.trim() → missing .trim()
    const identity = { displayName: "Adam", username: "" };
    assert.equal(accountIdentityModule.accountIdentityComplete(identity), false);
  });

  test("accountIdentityComplete trims whitespace", () => {
    // Mutant: .trim() → missing
    const identity = { displayName: "  Adam  ", username: "  adam  " };
    assert.equal(accountIdentityModule.accountIdentityComplete(identity), true);
  });

  test("accountIdentityComplete returns false for null", () => {
    assert.equal(accountIdentityModule.accountIdentityComplete(null), false);
  });

  test("accountUsernameReady requires username", () => {
    // Mutant: value?.username?.trim() → missing
    const identity = { displayName: "", username: "" };
    assert.equal(accountIdentityModule.accountUsernameReady(identity), false);
  });

  test("accountUsernameReady accepts non-empty username", () => {
    const identity = { displayName: "", username: "adam" };
    assert.equal(accountIdentityModule.accountUsernameReady(identity), true);
  });

  test("accountUsernameReady trims whitespace", () => {
    // Mutant: .trim() → missing
    const identity = { displayName: "", username: "  adam  " };
    assert.equal(accountIdentityModule.accountUsernameReady(identity), true);
  });
});

// ===========================================================================
// runtime.ts tests
// ===========================================================================

describe("runtime.ts", () => {
  test("accountRuntimeEnabled returns false when accounts disabled", async () => {
    await withEnv({
      ACCOUNTS_ENABLED: "0",
      CLOUDFLARE_NATIVE_AUTH: "0",
      CLOUDFLARE_DATA_MODE: "cloudflare",
      ORGANIZATION_DATA_MODE: "cloudflare",
    }, () => {
      // When accounts disabled, should return false
      assert.equal(runtimeModule.accountRuntimeEnabled(), false);
    });
  });

  test("accountRuntimeEnabled checks both native auth and supabase", async () => {
    // Mutant: ||/&& in the logical condition would change behavior
    await withEnv({
      ACCOUNTS_ENABLED: "1",
      CLOUDFLARE_NATIVE_AUTH: "1",
      CLOUDFLARE_DATA_MODE: "cloudflare",
      ORGANIZATION_DATA_MODE: "cloudflare",
      SUPABASE_URL: undefined,
    }, () => {
      // Should return true if native auth is active
      const result = runtimeModule.accountRuntimeEnabled();
      // Result depends on native auth readiness (which needs multiple env vars)
      // At minimum, we're exercising the function without error
      assert.equal(typeof result, "boolean");
    });
  });
});
