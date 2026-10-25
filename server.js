"use strict";

/*
============================================================
ALBERTO MARKETPLACE TOKEN (AMT)
PI BACKEND (APP LEDGER) — MAINNET
FULL SERVER VERSION 2.5.0-mainnet

IMPORTANT:
- MAINNET build — use Mainnet PI_API_KEY + PI_API_BASE=https://api.minepi.com
- Application ledger backend for AMT mining app
- Generated AMT- address is NOT a Pi/Stellar blockchain wallet
- Pi authentication is verified server-side (Mainnet)
- Mining / airdrop / transfers / staking = application-ledger accounting
- Pi Payments API depends on PI_API_KEY network (Mainnet key = Mainnet payments)
- In-app AMT balances are ledger accounting; on-chain Mainnet AMT is separate
- API root must report: network "Pi Mainnet", version "2.5.0-mainnet"

VERSION 2.5.0-mainnet:
- Forced Mainnet labels (removed Testnet display strings)
- Pet gear / weapon store, squad, story, battle charges
- Premium pets + Shadow/Light/Cosmic
- Login auth hardened for Mainnet keys

VERSION 2.4.3:
- OLD 1 AMT airdrop claims are cleared → users can claim new 100 AMT airdrop
- Status treats amount < 100 as NOT claimed
- Claim endpoint deletes old 1 AMT record then inserts 100 AMT

VERSION 2.4.2:
- Fixed profile picture saving (increased body limit to 10mb, image size to ~2MB)
- Accepts multiple field names: image, profileImage, photo, profile_image, avatar
- Better error messages when saving profile photo
- Staking fully present (pools, status, stake, unstake, history)

VERSION 2.4.1:
- Airdrop amount changed to 100 AMT
- Airdrop now has 48-hour claim timer (from account creation)
- Profile picture save endpoints preserved and working
- All referral system preserved

VERSION 2.4.0:
- Preserved all existing Pioneer records
- Preserved all existing AMT balances
- Preserved all existing mining sessions
- Preserved all existing ledger history
- Preserved reward/mining/staking logic
- Added verified Pi Mainnet wallet address to auth response
- Added verified Pi Mainnet wallet address to profile response
- Added verified Pi Mainnet wallet address to wallet response
- AMT ledger address remains separate from Pi wallet address
- FIXED: Explicitly return referralCode (= username) for every Pioneer
  in /api/auth/verify, /api/profile, /api/wallet, and /api/referral/status
- NEW: Added referral_code column to members table
- NEW: On every login, Pi username is permanently saved as referral_code
- NEW: referralCode is now read from the saved referral_code column
- FIXED: /api/referrals now returns referralCode + activeMiners
  (frontend was calling this endpoint and showing ------)
- NEW: Referral Tier System (Bronze / Silver / Gold / Legend / Mythic)
- NEW: Per-referral rewards + one-time milestone bonuses
- NEW: Automatic credit to AMT ledger when referral is linked
- NEW: AMT Pet Marketplace (70 real Common pets, 7 elements)
- NEW: Full Pet System - Care, Training, Breeding, Eggs, Hatch
- NEW: Public Sell / Listings, Battle (PvE)
============================================================
*/

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

/* =========================================================
CONFIGURATION
========================================================= */

const PORT = Number(process.env.PORT || 10000);

const PI_API_BASE =
  process.env.PI_API_BASE ||
  "https://api.minepi.com";

const PI_API_KEY =
  process.env.PI_API_KEY || "";

const DATABASE_URL =
  process.env.DATABASE_URL || "";

/* Testnet mining rate — AMT per hour. Override with env AMT_MINING_RATE */
const AMT_MINING_RATE = Number(
  process.env.AMT_MINING_RATE || "0.5"
);

const MINING_DURATION_SECONDS =
  24 * 60 * 60;

const MAXIMUM_BASE_REWARD = Number(
  (AMT_MINING_RATE * 24).toFixed(8)
);

/* Daily login reward — 1 claim per UTC day, streak bonus up to 7 days */
/* Day1→Day7 — higher to keep miners active */
const DAILY_REWARD_AMOUNTS = [2, 3, 4, 5, 7, 9, 12]; // index 0 = day 1 streak
const DAILY_MAX_STREAK = DAILY_REWARD_AMOUNTS.length;

/* Comeback bonus: if no mining claim in 3+ days, +5 AMT on next claim */
const COMEBACK_BONUS_AMT = Number(
  process.env.COMEBACK_BONUS_AMT || "5"
);
const COMEBACK_IDLE_DAYS = 3;

const AIRDROP_AMOUNT_AMT = Number(
  process.env.AIRDROP_AMOUNT_AMT || "100"
);

/* Developer in-app treasury for rewards / payments (one-time ledger credit) */
const DEV_TREASURY_AMT = Number(
  process.env.DEV_TREASURY_AMT || "5000000"
);
/* Match by Pi username and/or pi_uid (comma-separated). Empty = disabled. */
const DEV_PI_USERNAMES = String(
  process.env.DEV_PI_USERNAMES || process.env.DEV_PI_USERNAME || "utoy0913"
)
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
const DEV_PI_UIDS = String(process.env.DEV_PI_UIDS || process.env.DEV_PI_UID || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
/* Developer match: in-app AMT ledger address (AMT-...) — NOT on-chain G... */
const DEV_LEDGER_ADDRESSES = String(
  process.env.DEV_LEDGER_ADDRESS ||
    process.env.DEV_WALLETS ||
    process.env.DEV_WALLET_ADDRESS ||
    "AMT-654929D9EBBFAEB52B905BBB2C6A7A859685C092"
)
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);
const DEV_TREASURY_REF = "AMT-DEV-TREASURY-5M";

/* Airdrop claim window (shared campaign). Default: 30 days from campaign start.
   Override with env: AIRDROP_CAMPAIGN_START, AIRDROP_WINDOW_HOURS */
const AIRDROP_CLAIM_WINDOW_SECONDS =
  Number(process.env.AIRDROP_WINDOW_HOURS || "720") * 60 * 60; /* default 30 days */

/* Campaign start — reopen for Mainnet app era. Override via env if needed. */
const AIRDROP_CAMPAIGN_START_MS =
  new Date(
    process.env.AIRDROP_CAMPAIGN_START ||
    "2026-09-29T00:00:00.000Z"
  ).getTime();

const MAX_DIRECT_REFERRALS = null;

const MAX_SECURITY_CIRCLE = 5;

/* =========================================================
REFERRAL TIER SYSTEM
========================================================= */

const REFERRAL_TIERS = [
  { name: "Bronze", min: 1, max: 5, rewardPerReferral: 0.5 },
  { name: "Silver", min: 6, max: 15, rewardPerReferral: 1.0 },
  { name: "Gold", min: 16, max: 50, rewardPerReferral: 1.5 },
  { name: "Legend", min: 51, max: 99, rewardPerReferral: 2.0 },
  { name: "Mythic", min: 100, max: Infinity, rewardPerReferral: 3.0 }
];

const REFERRAL_MILESTONES = [
  { count: 5, bonus: 2.0, key: "M5" },
  { count: 15, bonus: 5.0, key: "M15" },
  { count: 50, bonus: 15.0, key: "M50" },
  { count: 100, bonus: 30.0, key: "M100" }
];

function getReferralTier(count) {
  const n = Number(count) || 0;
  for (const tier of REFERRAL_TIERS) {
    if (n >= tier.min && n <= tier.max) {
      return tier;
    }
  }
  return REFERRAL_TIERS[0];
}

const PI_PAYMENT_API_BASE =
  process.env.PI_PAYMENT_API_BASE ||
  process.env.PI_API_BASE ||
  "https://api.minepi.com";

const MARKET_TEST_OWNER_PI_UID =
  process.env.MARKET_TEST_OWNER_PI_UID || "";

const MARKET_TEST_OWNER_USERNAME =
  process.env.MARKET_TEST_OWNER_USERNAME || "";

const MARKET_TEST_PRICE_PI = Number(
  process.env.MARKET_TEST_PRICE_PI || "0.10"
);

const MARKET_TEST_PRODUCT_ID =
  process.env.MARKET_TEST_PRODUCT_ID ||
  "amt-test-pet-001";

/* =========================================================
STAKING CONFIGURATION
========================================================= */

const STAKING_MIN_AMOUNT_AMT = Number(
  process.env.STAKING_MIN_AMOUNT_AMT || "0.01"
);

const STAKING_POOLS = {
  "30D": {
    id: "30D",
    name: "Starter",
    lockDays: 30,
    rewardPercent: 5
  },

  "90D": {
    id: "90D",
    name: "Growth",
    lockDays: 90,
    rewardPercent: 10
  },

  "180D": {
    id: "180D",
    name: "Legend",
    lockDays: 180,
    rewardPercent: 15
  }
};

/* =========================================================
DATABASE
========================================================= */

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL
    ? { rejectUnauthorized: false }
    : undefined,
  // Free Render + free Postgres: keep pool small, fail fast, recycle idle
  max: 5,
  min: 0,
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 12000,
  allowExitOnIdle: true
});

pool.on("error", (err) => {
  console.error("PG POOL ERROR:", err && err.message ? err.message : err);
});

// Soft keep-alive so free DB / pool doesn't stay dead after idle (best-effort)
setInterval(() => {
  pool.query("SELECT 1").catch((e) => {
    console.warn("PG keepalive fail:", e && e.message ? e.message : e);
  });
}, 4 * 60 * 1000);

/* =========================================================
EXPRESS
========================================================= */

app.use(
  cors({
    origin: "*",
    methods: [
      "GET",
      "POST",
      "PUT",
      "DELETE",
      "OPTIONS"
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization"
    ]
  })
);

app.use(
  express.json({
    limit: "10mb"
  })
);

/* =========================================================
HELPERS
========================================================= */

function nowIso() {
  return new Date().toISOString();
}

function authToken(req) {
  const header =
    req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return "";
  }

  return header.slice(7).trim();
}

function cleanUsername(value) {
  return String(value || "").trim();
}

function validAmount(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const text = String(value).trim();
  const n = Number(text);

  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }

  if (text.includes(".")) {
    const decimals =
      text.split(".")[1].length;

    if (decimals > 8) {
      return null;
    }
  }

  return Number(n.toFixed(8));
}

function generateLedgerAddress() {
  return (
    "AMT-" +
    crypto
      .randomBytes(20)
      .toString("hex")
      .toUpperCase()
  );
}

function makeReference(prefix) {
  return (
    prefix +
    "-" +
    Date.now()
      .toString(36)
      .toUpperCase() +
    "-" +
    crypto
      .randomBytes(6)
      .toString("hex")
      .toUpperCase()
  );
}

class HttpError extends Error {
  constructor(
    status,
    message,
    extra = {}
  ) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/* =========================================================
PI API
========================================================= */

async function piApiRequest(
  path,
  options = {}
) {
  if (!PI_API_KEY) {
    throw new Error(
      "PI_API_KEY is not configured."
    );
  }

  const response = await fetch(
    `${PI_API_BASE}${path}`,
    {
      ...options,

      headers: {
        Accept: "application/json",
        "Content-Type":
          "application/json",
        Authorization:
          `Key ${PI_API_KEY}`,
        ...(options.headers || {})
      }
    }
  );

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    const error = new Error(
      data?.error ||
      data?.message ||
      `Pi API error ${response.status}`
    );

    error.status =
      response.status;

    error.data = data;

    throw error;
  }

  return data;
}

/* =========================================================
PI AUTHENTICATION
========================================================= */

function extractPiUser(payload) {
  if (!payload || typeof payload !== "object") return null;

  function pack(uid, username, wallet) {
    if (!uid) return null;
    return {
      uid: String(uid),
      username: username || null,
      walletAddress: wallet || null
    };
  }

  // Direct
  if (payload.uid || payload.sub || payload.user_uid || payload.userId) {
    return pack(
      payload.uid || payload.sub || payload.user_uid || payload.userId,
      payload.username || payload.preferred_username || payload.name || null,
      payload.wallet_address || payload.walletAddress || null
    );
  }
  // Nested user
  if (payload.user && typeof payload.user === "object") {
    const u = payload.user;
    if (u.uid || u.sub || u.id) {
      return pack(
        u.uid || u.sub || u.id,
        u.username || payload.username || null,
        u.wallet_address || u.walletAddress || payload.wallet_address || null
      );
    }
  }
  // Nested data / data.user
  if (payload.data && typeof payload.data === "object") {
    if (payload.data.uid || payload.data.sub) {
      return pack(
        payload.data.uid || payload.data.sub,
        payload.data.username || null,
        payload.data.wallet_address || null
      );
    }
    if (payload.data.user && (payload.data.user.uid || payload.data.user.sub)) {
      return pack(
        payload.data.user.uid || payload.data.user.sub,
        payload.data.user.username || null,
        payload.data.user.wallet_address || null
      );
    }
  }
  // credentials.user (some Pi SDK shapes)
  if (payload.credentials && payload.credentials.user) {
    const u = payload.credentials.user;
    if (u.uid || u.sub) {
      return pack(u.uid || u.sub, u.username || null, u.wallet_address || null);
    }
  }
  return null;
}

/** Best-effort decode of Pi access token JWT payload (no signature verify — used only as uid hint) */
function peekTokenClaims(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const json = Buffer.from(b64, "base64").toString("utf8");
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== "object") return null;
    return obj;
  } catch (_) {
    return null;
  }
}

async function verifyPiAccessToken(accessToken) {
  if (!accessToken) {
    throw new HttpError(401, "Pi access token is required.");
  }

  let token = String(accessToken).trim();
  // If client accidentally sent "Bearer xxx"
  if (/^bearer\s+/i.test(token)) token = token.replace(/^bearer\s+/i, "").trim();
  // If client sent JSON blob by mistake
  if (token.startsWith("{") && token.includes("accessToken")) {
    try {
      const obj = JSON.parse(token);
      if (obj.accessToken) token = String(obj.accessToken).trim();
    } catch (_) {}
  }

  const base = String(PI_API_BASE || "https://api.minepi.com").replace(/\/$/, "");
  // Prefer Mainnet; also try socialchain host if env mis-set historically
  const bases = [base];
  if (base.indexOf("api.minepi.com") >= 0) {
    /* main only */
  } else if (base.indexOf("socialchain") >= 0) {
    bases.push("https://api.minepi.com");
  }
  const paths = ["/v2/me", "/me", "/v2/user/me"];
  let lastStatus = 0;
  let lastBody = {};
  let lastRaw = "";
  let resolved = null;

  for (const b of bases) {
    for (const path of paths) {
      try {
        const response = await fetch(String(b).replace(/\/$/, "") + path, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: "Bearer " + token,
            ...(PI_API_KEY ? { "X-API-Key": PI_API_KEY } : {})
          }
        });
        const text = await response.text();
        lastRaw = text.slice(0, 400);
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text.slice(0, 200) };
        }
        lastStatus = response.status;
        lastBody = parsed;
        const found = extractPiUser(parsed);
        if (response.ok && found && found.uid) {
          resolved = found;
          break;
        }
      } catch (fetchErr) {
        console.warn("verifyPi fetch", path, fetchErr.message);
      }
    }
    if (resolved) break;
  }

  // Fallback: read uid from access token JWT claims if Pi /me returned odd 200 body
  if (!resolved || !resolved.uid) {
    const claims = peekTokenClaims(token);
    if (claims) {
      const fromJwt = extractPiUser(claims) || extractPiUser({ user: claims });
      if (fromJwt && fromJwt.uid) {
        // Only accept JWT fallback when Pi HTTP was 200 (token not rejected)
        if (lastStatus === 200 || lastStatus === 0) {
          console.warn("AUTH: using JWT claim uid fallback", {
            uid: String(fromJwt.uid).slice(0, 8) + "…",
            status: lastStatus
          });
          resolved = fromJwt;
        }
      }
    }
  }

  if (!resolved || !resolved.uid) {
    console.error("AUTH ERROR detail:", {
      status: lastStatus,
      bodyKeys: lastBody && typeof lastBody === "object" ? Object.keys(lastBody) : [],
      body: lastBody,
      rawPreview: lastRaw,
      apiBase: base,
      tokenPrefix: token.slice(0, 16) + "…",
      tokenLen: token.length,
      hasApiKey: !!PI_API_KEY,
      keyPrefix: String(PI_API_KEY || "").slice(0, 6)
    });
    let hint = "";
    if (lastStatus === 401) {
      hint =
        " Token rejected. Check: 1) PI_API_BASE=https://api.minepi.com 2) Mainnet app API key on Render 3) Login only inside Pi Browser 4) Clear cache & login again.";
    } else if (lastStatus === 200) {
      hint =
        " Pi HTTP 200 but no uid in body. Confirm Mainnet app in Pi Developer Portal, PI_API_KEY is Mainnet key, frontend sandbox:false, then hard refresh + Login with Pi.";
    } else if (!lastStatus) {
      hint = " No response from Pi API — network/DNS issue on Render.";
    }
    throw new HttpError(
      401,
      (lastBody && (lastBody.error || lastBody.message)) ||
        ("Pi authentication failed (" + (lastStatus || 401) + ").") + hint
    );
  }

  return {
    uid: String(resolved.uid),
    username: cleanUsername(resolved.username),
    walletAddress: resolved.walletAddress || null
  };
}

/* =========================================================
AMT LEDGER WALLET
========================================================= */

async function ensureAmtWallet(
  memberId,
  db = pool
) {
  let result =
    await db.query(
      `
      SELECT
        id,
        member_id,
        wallet_status,
        wallet_address
      FROM amt_wallets
      WHERE member_id = $1
      LIMIT 1
      `,
      [memberId]
    );

  if (result.rows.length) {
    const wallet =
      result.rows[0];

    if (wallet.wallet_address) {
      return wallet;
    }
  }

  for (
    let attempt = 0;
    attempt < 5;
    attempt++
  ) {
    const address =
      generateLedgerAddress();

    try {
      result =
        await db.query(
          `
          INSERT INTO amt_wallets
            (
              member_id,
              wallet_status,
              wallet_address
            )
          VALUES
            (
              $1,
              'LEDGER_ACTIVE',
              $2
            )
          ON CONFLICT (member_id)
          DO UPDATE SET
            wallet_status =
              CASE
                WHEN amt_wallets.wallet_address IS NULL
                THEN 'LEDGER_ACTIVE'
                ELSE amt_wallets.wallet_status
              END,

            wallet_address =
              COALESCE(
                amt_wallets.wallet_address,
                EXCLUDED.wallet_address
              ),

            updated_at = NOW()

          RETURNING
            id,
            member_id,
            wallet_status,
            wallet_address
          `,
          [
            memberId,
            address
          ]
        );

      return result.rows[0];

    } catch (error) {
      if (
        error.code === "23505"
      ) {
        continue;
      }

      throw error;
    }
  }

  throw new Error(
    "Unable to create AMT ledger wallet."
  );
}

/* =========================================================
AUTHENTICATED MEMBER
========================================================= */

async function getAuthenticatedMember(
  accessToken
) {
  const piUser =
    await verifyPiAccessToken(
      accessToken
    );

  /*
   IMPORTANT:
   Pi UID is the permanent account key.
   Existing members are UPDATED, NOT recreated.
  */

  const result =
    await pool.query(
      `
      INSERT INTO members
        (
          pi_uid,
          username,
          referral_code,
          pi_wallet_address
        )
      VALUES
        (
          $1,
          $2,
          $2,
          $3
        )

      ON CONFLICT (pi_uid)
      DO UPDATE SET

        username =
          CASE
            WHEN EXCLUDED.username <> ''
            THEN EXCLUDED.username
            ELSE members.username
          END,

        referral_code =
          CASE
            WHEN EXCLUDED.username <> ''
            THEN EXCLUDED.username
            ELSE COALESCE(
              members.referral_code,
              members.username
            )
          END,

        /* Sync Pi wallet address whenever Pi API returns one */
        pi_wallet_address =
          CASE
            WHEN EXCLUDED.pi_wallet_address IS NOT NULL
              AND EXCLUDED.pi_wallet_address <> ''
            THEN EXCLUDED.pi_wallet_address
            ELSE members.pi_wallet_address
          END,

        updated_at = NOW()

      RETURNING *
      `,
      [
        piUser.uid,
        piUser.username,
        piUser.walletAddress || null
      ]
    );

  const member =
    result.rows[0];

  /* Always ensure AMT ledger wallet exists on every login */
  const wallet =
    await ensureAmtWallet(
      member.id
    );

  /* Developer treasury: one-time 5M in-app AMT for rewards / payments */
  try {
    await ensureDevTreasury(member, piUser, wallet);
  } catch (e) {
    console.error("DEV TREASURY:", e.message || e);
  }

  return {
    member,
    wallet,
    piUser
  };
}

async function ensureDevTreasury(member, piUser, ledgerWallet) {
  if (!member || !member.id) return;
  if (DEV_TREASURY_AMT <= 0) return;

  const uname = String(
    (piUser && piUser.username) || member.username || ""
  )
    .trim()
    .toLowerCase();
  const uid = String((piUser && piUser.uid) || member.pi_uid || "").trim();

  // In-app ledger address (AMT-...)
  let ledgerAddr = String(
    (ledgerWallet && ledgerWallet.wallet_address) || ""
  )
    .trim()
    .toUpperCase();
  if (!ledgerAddr) {
    try {
      const w = await pool.query(
        `SELECT wallet_address FROM amt_wallets WHERE member_id = $1 LIMIT 1`,
        [member.id]
      );
      ledgerAddr = String(w.rows[0]?.wallet_address || "")
        .trim()
        .toUpperCase();
    } catch (e) {}
  }

  // Prefix match: env may have short AMT-... if full address was truncated in UI copy
  const matchUser =
    DEV_PI_USERNAMES.length > 0 && DEV_PI_USERNAMES.includes(uname);
  const matchUid =
    DEV_PI_UIDS.length > 0 && DEV_PI_UIDS.includes(uid);
  const matchLedger =
    ledgerAddr &&
    DEV_LEDGER_ADDRESSES.length > 0 &&
    DEV_LEDGER_ADDRESSES.some(
      (a) =>
        ledgerAddr === a ||
        ledgerAddr.startsWith(a) ||
        a.startsWith(ledgerAddr)
    );

  if (!matchUser && !matchUid && !matchLedger) {
    if (process.env.DEV_TREASURY_DEBUG === "1") {
      console.log("DEV TREASURY skip (no match)", {
        uname,
        uid,
        ledgerAddr,
        envUsers: DEV_PI_USERNAMES,
        envUids: DEV_PI_UIDS,
        envLedgers: DEV_LEDGER_ADDRESSES
      });
    }
    return false;
  }

  const exists = await pool.query(
    `SELECT id FROM amt_ledger
     WHERE member_id = $1 AND reference = $2
     LIMIT 1`,
    [member.id, DEV_TREASURY_REF]
  );
  if (exists.rows.length) {
    console.log(
      "DEV TREASURY already credited for member",
      member.id
    );
    return false;
  }

  await pool.query(
    `INSERT INTO amt_ledger (member_id, amount, type, reference)
     VALUES ($1, $2, 'DEV_TREASURY', $3)`,
    [member.id, DEV_TREASURY_AMT, DEV_TREASURY_REF]
  );
  console.log(
    "DEV TREASURY credited:",
    DEV_TREASURY_AMT,
    "AMT → member",
    member.id,
    ledgerAddr || uname || uid
  );
  return true;
}

async function requireAuth(
  req,
  res,
  next
) {
  try {
    const token =
      authToken(req);

    if (!token) {
      return res
        .status(401)
        .json({
          ok: false,
          error:
            "Pi login required."
        });
    }

    const auth =
      await getAuthenticatedMember(
        token
      );

    req.accessToken =
      token;

    req.member =
      auth.member;

    req.wallet =
      auth.wallet;

    req.piUser =
      auth.piUser;

    next();

  } catch (error) {
    console.error(
      "AUTH ERROR:",
      error
    );

    return res
      .status(
        error.status || 401
      )
      .json({
        ok: false,
        error:
          error.message ||
          "Authentication failed."
      });
  }
}

/* =========================================================
DATABASE INITIALIZATION
========================================================= */

async function initializeDatabase() {
  if (!DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is required."
    );
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id BIGSERIAL PRIMARY KEY,

      pi_uid TEXT UNIQUE NOT NULL,

      username TEXT NOT NULL
        DEFAULT '',

      referral_code TEXT,

      kyc_status TEXT NOT NULL
        DEFAULT 'UNVERIFIED',

      profile_image TEXT,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );

    ALTER TABLE members
      ADD COLUMN IF NOT EXISTS
      profile_image TEXT;

    ALTER TABLE members
      ADD COLUMN IF NOT EXISTS
      referral_code TEXT;

    ALTER TABLE members
      ADD COLUMN IF NOT EXISTS
      pi_wallet_address TEXT;

    -- Backfill existing members: set referral_code = username if still null
    UPDATE members
    SET referral_code = username
    WHERE
      (referral_code IS NULL OR referral_code = '')
      AND username IS NOT NULL
      AND username <> '';
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS amt_wallets (
      id BIGSERIAL PRIMARY KEY,

      member_id BIGINT UNIQUE NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      wallet_status TEXT NOT NULL
        DEFAULT 'NOT_CONNECTED',

      wallet_address TEXT UNIQUE,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mining_sessions (
      id BIGSERIAL PRIMARY KEY,

      member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      started_at TIMESTAMPTZ NOT NULL,

      ends_at TIMESTAMPTZ NOT NULL,

      status TEXT NOT NULL
        DEFAULT 'ACTIVE',

      rate NUMERIC(30,8) NOT NULL,

      claimed_amount NUMERIC(30,8)
        NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS amt_ledger (
      id BIGSERIAL PRIMARY KEY,

      member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      amount NUMERIC(30,8) NOT NULL,

      type TEXT NOT NULL,

      reference TEXT UNIQUE NOT NULL,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS referrals (
      id BIGSERIAL PRIMARY KEY,

      referrer_member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      referred_member_id BIGINT UNIQUE NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      status TEXT NOT NULL
        DEFAULT 'ACTIVE',

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS security_circle (
      id BIGSERIAL PRIMARY KEY,

      owner_member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      status TEXT NOT NULL
        DEFAULT 'ACTIVE',

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      UNIQUE(
        owner_member_id,
        member_id
      )
    );

    CREATE TABLE IF NOT EXISTS marketplace_payments (
      id BIGSERIAL PRIMARY KEY,

      pi_payment_id TEXT UNIQUE NOT NULL,

      member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      product_id TEXT NOT NULL,

      amount NUMERIC(30,8) NOT NULL,

      status TEXT NOT NULL
        DEFAULT 'APPROVED',

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS marketplace_purchases (
      id BIGSERIAL PRIMARY KEY,

      payment_id BIGINT NOT NULL
        REFERENCES marketplace_payments(id)
        ON DELETE CASCADE,

      member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      product_id TEXT NOT NULL,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS amt_transfers (
      id BIGSERIAL PRIMARY KEY,

      tx_id TEXT UNIQUE NOT NULL,

      sender_member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      recipient_member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      amount NUMERIC(30,8) NOT NULL,

      memo TEXT NOT NULL
        DEFAULT '',

      status TEXT NOT NULL
        DEFAULT 'COMPLETED',

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS amt_airdrops (
      id BIGSERIAL PRIMARY KEY,

      member_id BIGINT UNIQUE NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      amount NUMERIC(30,8) NOT NULL,

      reference TEXT UNIQUE NOT NULL,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS amt_stakes (
      id BIGSERIAL PRIMARY KEY,

      member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      pool_id TEXT NOT NULL,

      principal NUMERIC(30,8) NOT NULL,

      reward_rate NUMERIC(12,8) NOT NULL,

      reward_amount NUMERIC(30,8) NOT NULL,

      started_at TIMESTAMPTZ NOT NULL,

      unlock_at TIMESTAMPTZ NOT NULL,

      status TEXT NOT NULL
        DEFAULT 'ACTIVE',

      unstaked_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
      idx_mining_member
      ON mining_sessions(member_id);

    CREATE INDEX IF NOT EXISTS
      idx_ledger_member
      ON amt_ledger(member_id);

    CREATE INDEX IF NOT EXISTS
      idx_referrals_referrer
      ON referrals(referrer_member_id);

    CREATE INDEX IF NOT EXISTS
      idx_security_owner
      ON security_circle(owner_member_id);

    CREATE INDEX IF NOT EXISTS
      idx_transfers_sender
      ON amt_transfers(sender_member_id);

    CREATE INDEX IF NOT EXISTS
      idx_transfers_recipient
      ON amt_transfers(recipient_member_id);

    CREATE INDEX IF NOT EXISTS
      idx_airdrop_member
      ON amt_airdrops(member_id);

    CREATE INDEX IF NOT EXISTS
      idx_stakes_member
      ON amt_stakes(member_id);

    CREATE INDEX IF NOT EXISTS
      idx_stakes_active
      ON amt_stakes(
        member_id,
        status
      );

    CREATE INDEX IF NOT EXISTS
      idx_stakes_unlock
      ON amt_stakes(unlock_at);
  `);

  console.log(
    "Database initialized."
  );
}

/* =========================================================
ROOT
========================================================= */


/* Auth config check (no secrets) — helps debug login 401 */
app.get("/api/health/auth-config", (req, res) => {
  const base = String(process.env.PI_API_BASE || PI_API_BASE || "https://api.minepi.com").replace(/\/$/, "");
  res.json({
    ok: true,
    environment: "MAINNET",
    piApiBase: base,
    hasPiApiKey: !!(process.env.PI_API_KEY || PI_API_KEY),
    keyPrefix: (process.env.PI_API_KEY || PI_API_KEY || "").slice(0, 6) || null,
    expectedBase: "https://api.minepi.com",
    baseOk: base.indexOf("api.minepi.com") >= 0 && base.indexOf("testnet") < 0
  });
});

app.get("/", async (req, res) => {
  res.json({
    ok: true,

    service:
      "Alberto Marketplace Token",

    symbol:
      "AMT",

    network:
      "Pi Mainnet",

    environment:
      "MAINNET",

    version:
      "2.5.0-mainnet",

    features: [
      "Pi Login",
      "AMT Mining",
      "AMT Wallet",
      "AMT Transfers",
      "Airdrop",
      "Referral",
      "Security Circle",
      "Profile",
      "Marketplace",
      "Staking"
    ],

    timestamp:
      nowIso()
  });
});

/* =========================================================
HEALTH
========================================================= */

async function healthHandler(req, res) {
  let db = "OK";
  let dbError = null;
  try {
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise((_, rej) => setTimeout(() => rej(new Error("db_timeout")), 8000))
    ]);
  } catch (e) {
    db = "ERROR";
    dbError = (e && e.message) ? String(e.message) : "db_unreachable";
    // One retry after short wait (cold DB)
    try {
      await new Promise((r) => setTimeout(r, 1500));
      await Promise.race([
        pool.query("SELECT 1"),
        new Promise((_, rej) => setTimeout(() => rej(new Error("db_timeout")), 8000))
      ]);
      db = "OK";
      dbError = null;
    } catch (e2) {
      dbError = (e2 && e2.message) ? String(e2.message) : dbError;
    }
  }
  res.status(db === "OK" ? 200 : 503).json({
    ok: db === "OK",
    service: "AMT Mainnet Backend",
    database: db,
    databaseError: dbError,
    piApiKeyConfigured: Boolean(PI_API_KEY),
    network: "Pi Mainnet",
    environment: "MAINNET",
    staking: true,
    timestamp: nowIso()
  });
}

app.get(
  "/health",
  healthHandler
);


/* Keep-alive target for UptimeRobot / cron (every 5–10 min) */
app.get("/api/ping", (req, res) => {
  res.status(200).json({ ok: true, ts: Date.now(), service: "AMT" });
});

app.get(
  "/api/health",
  healthHandler
);

/* =========================================================
AUTH
========================================================= */

/*
 * FIX:
 * Frontend calls GET /api/auth/verify.
 *
 * Previous version accepted POST only,
 * which caused:
 *
 * GET /api/auth/verify -> 404
 *
 * app.all() safely accepts both GET and POST
 * without changing the authentication logic.
 */

app.all(
  "/api/auth/verify",
  requireAuth,
  async (req, res) => {
    try {
      res.json({
        ok: true,

        /*
         * Explicit verified Pi wallet address.
         * This is the address returned by Pi API.
         */
        piWalletAddress:
          req.piUser.walletAddress ||
          req.member.pi_wallet_address ||
          null,

        /*
         * Current frontend can read data.piUser.
         */
        piUser: {
          uid:
            req.piUser.uid,

          username:
            req.piUser.username,

          walletAddress:
            req.piUser.walletAddress ||
            req.member.pi_wallet_address ||
            null
        },

        /*
         * Existing user object preserved.
         */
        user: {
          uid:
            req.piUser.uid,

          username:
            req.piUser.username,

          kycStatus:
            req.member.kyc_status,

          profileImage:
            req.member
              .profile_image || null
        },

        /*
         * IMPORTANT:
         * wallet.walletAddress is still the AMT
         * application ledger address.
         */
        wallet: {
          walletStatus:
            req.wallet
              .wallet_status,

          walletAddress:
            req.wallet
              .wallet_address,

          isBlockchainWallet:
            false,

          walletType:
            "AMT_MAINNET_LEDGER"
        },

        network:
          "Pi Mainnet",

        environment:
          "MAINNET",

        // Referral code of this Pioneer (saved from Pi username on login)
        referralCode:
          req.member.referral_code ||
          req.member.username ||
          req.piUser.username ||
          null
      });

    } catch (error) {
      console.error(
        "AUTH VERIFY RESPONSE ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            error.message ||
            "Unable to verify authentication."
        });
    }
  }
);

/* =========================================================
PROFILE
========================================================= */

app.get(
  "/api/profile",
  requireAuth,
  async (req, res) => {
    res.json({
      ok: true,

      uid:
        req.piUser.uid,

      username:
        req.piUser.username,

      kycStatus:
        req.member.kyc_status,

      profileImage:
        req.member
          .profile_image || null,

      /*
       * VERIFIED Pi wallet address (live from Pi API, else saved).
       */
      piWalletAddress:
        req.piUser.walletAddress ||
        req.member.pi_wallet_address ||
        null,

      walletStatus:
        req.wallet
          .wallet_status,

      /*
       * AMT application ledger address.
       */
      walletAddress:
        req.wallet
          .wallet_address,

      walletType:
        "AMT_MAINNET_LEDGER",

      isBlockchainWallet:
        false,

      network:
        "Pi Mainnet",

      environment:
        "MAINNET",

      // Referral code of this Pioneer (saved from Pi username on login)
      referralCode:
        req.member.referral_code ||
        req.member.username ||
        req.piUser.username ||
        null
    });
  }
);

app.post(
  "/api/profile/photo",
  requireAuth,
  async (req, res) => {
    try {
      // Accept common field names used by different frontends
      const image =
        String(
          req.body?.image ||
          req.body?.profileImage ||
          req.body?.photo ||
          req.body?.profile_image ||
          req.body?.avatar ||
          ""
        ).trim();

      if (!image) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Profile image is required. Send base64 as 'image' or 'profileImage'."
          });
      }

      if (
        !image.startsWith(
          "data:image/"
        )
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Invalid image format. Must start with data:image/ (base64)."
          });
      }

      // Increased limit: ~3MB base64 (~2.2MB actual image)
      if (
        image.length > 4000000
      ) {
        return res
          .status(413)
          .json({
            ok: false,
            error:
              "Profile image is too large. Max ~2MB."
          });
      }

      await pool.query(
        `
        UPDATE members
        SET
          profile_image = $1,
          updated_at = NOW()
        WHERE id = $2
        `,
        [
          image,
          req.member.id
        ]
      );

      res.json({
        ok: true,

        profileImage:
          image,

        saved: true
      });

    } catch (error) {
      console.error(
        "PHOTO ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to save profile image.",
          detail:
            error.message || null
        });
    }
  }
);

app.delete(
  "/api/profile/photo",
  requireAuth,
  async (req, res) => {
    await pool.query(
      `
      UPDATE members
      SET
        profile_image = NULL,
        updated_at = NOW()
      WHERE id = $1
      `,
      [req.member.id]
    );

    res.json({
      ok: true,
      profileImage:
        null
    });
  }
);

/* =========================================================
KYC
========================================================= */

app.get(
  "/api/kyc/status",
  requireAuth,
  async (req, res) => {
    const verified =
      String(
        req.member.kyc_status
      ).toUpperCase() ===
      "VERIFIED";

    res.json({
      ok: true,

      status:
        req.member
          .kyc_status,

      miningAllowed:
        true,

      migrationEligible:
        verified,

      protectedTransactionsEligible:
        verified
    });
  }
);

/* =========================================================
BALANCE HELPERS
========================================================= */

async function getBalance(
  memberId,
  db = pool
) {
  const result =
    await db.query(
      `
      SELECT
        COALESCE(
          SUM(amount),
          0
        )::NUMERIC(30,8)
        AS balance

      FROM amt_ledger

      WHERE member_id = $1
      `,
      [memberId]
    );

  return Number(
    result.rows[0]?.balance || 0
  );
}

async function getStakingSummary(
  memberId,
  db = pool
) {
  const result =
    await db.query(
      `
      SELECT

        COALESCE(
          SUM(
            CASE
              WHEN status = 'ACTIVE'
              THEN principal
              ELSE 0
            END
          ),
          0
        )::NUMERIC(30,8)
        AS staked_principal,

        COALESCE(
          SUM(
            CASE
              WHEN status = 'ACTIVE'
              THEN reward_amount
              ELSE 0
            END
          ),
          0
        )::NUMERIC(30,8)
        AS pending_rewards

      FROM amt_stakes

      WHERE member_id = $1
      `,
      [memberId]
    );

  const row =
    result.rows[0];

  return {
    stakedPrincipal:
      Number(
        row?.staked_principal || 0
      ),

    pendingRewards:
      Number(
        row?.pending_rewards || 0
      )
  };
}

/* =========================================================
WALLET
========================================================= */

app.get(
  "/api/wallet",
  requireAuth,
  async (req, res) => {
    const balance =
      await getBalance(
        req.member.id
      );

    const staking =
      await getStakingSummary(
        req.member.id
      );

    const totalBalance =
      Number(
        (
          balance +
          staking.stakedPrincipal
        ).toFixed(8)
      );

    res.json({
      ok: true,

      symbol:
        "AMT",

      balance,

      availableBalance:
        balance,

      stakedBalance:
        staking.stakedPrincipal,

      pendingStakingRewards:
        staking.pendingRewards,

      totalBalance,

      network:
        "Pi Mainnet",

      environment:
        "MAINNET",

      /*
       * VERIFIED Pi Testnet wallet (live from Pi API, else saved on login).
       */
      piWalletAddress:
        req.piUser.walletAddress ||
        req.member.pi_wallet_address ||
        null,

      /*
       * AMT application ledger wallet.
       * Always created on login via ensureAmtWallet.
       */
      walletStatus:
        req.wallet
          .wallet_status,

      walletAddress:
        req.wallet
          .wallet_address,

      /*
       * Explicit AMT ledger field.
       */
      ledgerWalletAddress:
        req.wallet
          .wallet_address,

      walletSynced:
        true,

      isBlockchainWallet:
        false,

      walletType:
        "AMT_MAINNET_LEDGER",

      // Referral code of this Pioneer (saved from Pi username on login)
      referralCode:
        req.member.referral_code ||
        req.member.username ||
        req.piUser.username ||
        null
    });
  }
);

/* =========================================================
LINK PI WALLET (own address only — never shared with others)
========================================================= */

function isValidPiWalletAddress(value) {
  const addr = String(value || "").trim().toUpperCase();
  // Stellar/Pi public key: G + 55 base32 chars = 56 total
  if (!/^G[A-Z2-7]{55}$/.test(addr)) {
    return null;
  }
  return addr;
}

app.post(
  "/api/wallet/link-pi",
  requireAuth,
  async (req, res) => {
    try {
      const raw =
        req.body?.piWalletAddress ||
        req.body?.walletAddress ||
        req.body?.address ||
        "";

      const address =
        isValidPiWalletAddress(raw);

      if (!address) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid Pi wallet address. Must be a G... address (56 characters)."
        });
      }

      /*
       * IMPORTANT:
       * Saves ONLY to this authenticated member's row.
       * Other Pioneers cannot read or use this address.
       */
      await pool.query(
        `
        UPDATE members
        SET
          pi_wallet_address = $1,
          updated_at = NOW()
        WHERE id = $2
        `,
        [address, req.member.id]
      );

      res.json({
        ok: true,
        linked: true,
        piWalletAddress: address,
        message:
          "Pi wallet linked to your account only."
      });
    } catch (error) {
      console.error("LINK PI WALLET ERROR:", error);
      res.status(500).json({
        ok: false,
        error: "Unable to link Pi wallet."
      });
    }
  }
);

app.delete(
  "/api/wallet/link-pi",
  requireAuth,
  async (req, res) => {
    try {
      await pool.query(
        `
        UPDATE members
        SET
          pi_wallet_address = NULL,
          updated_at = NOW()
        WHERE id = $1
        `,
        [req.member.id]
      );

      res.json({
        ok: true,
        linked: false,
        piWalletAddress: null
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: "Unable to unlink Pi wallet."
      });
    }
  }
);

/* =========================================================
ON-CHAIN BALANCES (Pi Mainnet Horizon — own wallet only)
========================================================= */

const PI_HORIZON_MAINNET =
  process.env.PI_HORIZON_MAINNET ||
  process.env.PI_HORIZON_BASE ||
  "https://api.mainnet.minepi.com";

const PI_HORIZON_TESTNET =
  process.env.PI_HORIZON_TESTNET ||
  "https://api.testnet.minepi.com";

const PI_HORIZON_TESTNET_2 =
  process.env.PI_HORIZON_TESTNET_2 ||
  "https://api.testnet2.minepi.com";

/** Prefer Mainnet PI balance; optional Testnet for on-chain AMT tests */
async function fetchHorizonAccount(address, preferMainnet = true) {
  const urls = preferMainnet
    ? [
        `${PI_HORIZON_MAINNET}/accounts/${encodeURIComponent(address)}`,
        `${PI_HORIZON_TESTNET}/accounts/${encodeURIComponent(address)}`,
        `${PI_HORIZON_TESTNET_2}/accounts/${encodeURIComponent(address)}`
      ]
    : [
        `${PI_HORIZON_TESTNET}/accounts/${encodeURIComponent(address)}`,
        `${PI_HORIZON_TESTNET_2}/accounts/${encodeURIComponent(address)}`,
        `${PI_HORIZON_MAINNET}/accounts/${encodeURIComponent(address)}`
      ];

  let lastError = null;
  let last404 = null;

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" }
      });

      if (response.status === 404) {
        last404 = { exists: false, balances: [], horizon: horizonLabel(url) };
        continue;
      }

      if (!response.ok) {
        lastError = new Error(`Horizon ${response.status}`);
        continue;
      }

      const data = await response.json();
      return {
        exists: true,
        balances: Array.isArray(data.balances) ? data.balances : [],
        horizon: horizonLabel(url)
      };
    } catch (err) {
      lastError = err;
    }
  }

  if (last404) return last404;
  throw lastError || new Error("Horizon unavailable");
}

function horizonLabel(url) {
  if (url.includes("mainnet")) return "mainnet";
  if (url.includes("testnet2")) return "testnet2";
  return "testnet";
}

app.get(
  "/api/wallet/onchain",
  requireAuth,
  async (req, res) => {
    try {
      const address =
        req.member.pi_wallet_address ||
        req.piUser.walletAddress ||
        null;

      if (!address) {
        return res.json({
          ok: true,
          linked: false,
          piWalletAddress: null,
          testPiBalance: null,
          onchainAmtBalance: null,
          otherTokens: [],
          message:
            "Link your Pi Mainnet wallet (G...) to see Mainnet PI balance."
        });
      }

      // Mainnet first → native PI balance for miners
      const account = await fetchHorizonAccount(address, true);

      if (!account.exists) {
        return res.json({
          ok: true,
          linked: true,
          piWalletAddress: address,
          accountExists: false,
          mainnetPiBalance: 0,
          testPiBalance: 0,
          onchainAmtBalance: 0,
          otherTokens: [],
          horizon: account.horizon || "mainnet",
          network: "Pi Mainnet",
          message:
            "Wallet not found on Pi Mainnet yet (or not activated)."
        });
      }

      let mainnetPiBalance = 0;
      let testPiBalance = 0;
      let onchainAmtBalance = 0;
      const otherTokens = [];
      const isMainnet = account.horizon === "mainnet";

      for (const b of account.balances) {
        const amount = Number(b.balance || 0);

        if (b.asset_type === "native") {
          if (isMainnet) mainnetPiBalance = amount;
          else testPiBalance = amount;
          continue;
        }

        const code = String(b.asset_code || "");
        const issuer = String(b.asset_issuer || "");

        if (code.toUpperCase() === "AMT") {
          onchainAmtBalance += amount;
        } else {
          otherTokens.push({
            code,
            issuer,
            balance: amount
          });
        }
      }

      // If Mainnet had no AMT, try Testnet for on-chain AMT only (optional)
      if (isMainnet && onchainAmtBalance === 0) {
        try {
          const tn = await fetchHorizonAccount(address, false);
          if (tn.exists) {
            for (const b of tn.balances) {
              const amount = Number(b.balance || 0);
              if (b.asset_type === "native") {
                testPiBalance = amount;
              } else if (String(b.asset_code || "").toUpperCase() === "AMT") {
                onchainAmtBalance += amount;
              }
            }
          }
        } catch (e) {
          /* ignore testnet fallback errors */
        }
      }

      res.json({
        ok: true,
        linked: true,
        accountExists: true,
        piWalletAddress: address,
        mainnetPiBalance,
        testPiBalance,
        onchainAmtBalance,
        otherTokens,
        horizon: account.horizon || "mainnet",
        network: isMainnet ? "Pi Mainnet" : "Pi Mainnet"
      });
    } catch (error) {
      console.error("ONCHAIN BALANCE ERROR:", error);
      res.status(500).json({
        ok: false,
        error:
          "Unable to fetch on-chain balances from Pi network."
      });
    }
  }
);

/* =========================================================
ON-CHAIN AMT DEPOSIT → IN-APP LEDGER (utility bridge)
Pioneer sends on-chain AMT to app treasury, pastes tx hash,
we verify on Horizon, credit in-app AMT 1:1 (testnet).
========================================================= */

const AMT_ONCHAIN_TREASURY =
  process.env.AMT_ONCHAIN_TREASURY || "";

const AMT_ASSET_CODE =
  process.env.AMT_ASSET_CODE || "AMT";

async function ensureOnchainDepositTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS onchain_deposits (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT NOT NULL REFERENCES members(id),
      tx_hash TEXT NOT NULL UNIQUE,
      amount NUMERIC(24,8) NOT NULL,
      from_address TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function fetchHorizonTxOperations(txHash) {
  const bases = [PI_HORIZON_BASE, PI_HORIZON_BASE_2];
  for (const base of bases) {
    try {
      const url =
        `${base}/transactions/${encodeURIComponent(txHash)}/operations?limit=50`;
      const response = await fetch(url, {
        headers: { Accept: "application/json" }
      });
      if (!response.ok) continue;
      const data = await response.json();
      const records =
        data._embedded && data._embedded.records
          ? data._embedded.records
          : [];
      return records;
    } catch (e) {
      /* try next */
    }
  }
  return null;
}

app.get(
  "/api/onchain/deposit-info",
  requireAuth,
  async (req, res) => {
    try {
      await ensureOnchainDepositTable();

      res.json({
        ok: true,
        enabled: Boolean(AMT_ONCHAIN_TREASURY),
        treasuryAddress: AMT_ONCHAIN_TREASURY || null,
        assetCode: AMT_ASSET_CODE,
        rate: "1 on-chain AMT = 1 in-app AMT",
        network: "Pi Mainnet",
        instructions: AMT_ONCHAIN_TREASURY
          ? [
              "1. Open Pi Wallet (Testnet)",
              "2. Send AMT token to the treasury address below",
              "3. Copy the transaction hash",
              "4. Paste hash here and claim — in-app AMT credited 1:1"
            ]
          : [
              "Set AMT_ONCHAIN_TREASURY env on server to enable deposits."
            ],
        yourPiWallet:
          req.member.pi_wallet_address ||
          req.piUser.walletAddress ||
          null
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: "Unable to load deposit info."
      });
    }
  }
);

app.post(
  "/api/onchain/deposit-claim",
  requireAuth,
  async (req, res) => {
    const client = await pool.connect();

    try {
      await ensureOnchainDepositTable();

      if (!AMT_ONCHAIN_TREASURY) {
        return res.status(503).json({
          ok: false,
          error:
            "On-chain deposit not configured. Set AMT_ONCHAIN_TREASURY."
        });
      }

      const txHash = String(
        req.body?.txHash ||
          req.body?.transactionHash ||
          req.body?.hash ||
          ""
      )
        .trim()
        .toLowerCase();

      if (!/^[a-f0-9]{64}$/.test(txHash)) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid transaction hash. Paste the 64-character tx hash."
        });
      }

      // Already claimed?
      const existing = await client.query(
        `SELECT id FROM onchain_deposits WHERE tx_hash = $1`,
        [txHash]
      );
      if (existing.rows.length > 0) {
        return res.status(400).json({
          ok: false,
          error: "This transaction was already claimed."
        });
      }

      const operations = await fetchHorizonTxOperations(txHash);
      if (!operations) {
        return res.status(400).json({
          ok: false,
          error:
            "Transaction not found on Pi Mainnet. Check hash and network."
        });
      }

      const treasury = AMT_ONCHAIN_TREASURY.toUpperCase();
      let creditedAmount = 0;
      let fromAddress = null;

      for (const op of operations) {
        if (op.type !== "payment" && op.type_i !== 1) continue;

        const to = String(
          op.to || op.destination || ""
        ).toUpperCase();
        const code = String(
          op.asset_code || ""
        ).toUpperCase();
        const assetType = String(op.asset_type || "");

        // Must be AMT (non-native) payment to treasury
        if (to !== treasury) continue;
        if (assetType === "native") continue;
        if (code !== AMT_ASSET_CODE.toUpperCase()) continue;

        const amt = Number(op.amount || 0);
        if (amt > 0) {
          creditedAmount += amt;
          fromAddress = op.from || op.source_account || null;
        }
      }

      if (creditedAmount <= 0) {
        return res.status(400).json({
          ok: false,
          error:
            `No ${AMT_ASSET_CODE} payment to app treasury found in this transaction.`
        });
      }

      await client.query("BEGIN");

      await client.query(
        `
        INSERT INTO onchain_deposits
          (member_id, tx_hash, amount, from_address)
        VALUES ($1, $2, $3, $4)
        `,
        [
          req.member.id,
          txHash,
          creditedAmount,
          fromAddress
        ]
      );

      const reference = `ONCHAIN_DEPOSIT:${txHash.slice(0, 16)}`;

      await client.query(
        `
        INSERT INTO amt_ledger
          (member_id, amount, type, reference)
        VALUES ($1, $2, 'ONCHAIN_DEPOSIT', $3)
        `,
        [req.member.id, creditedAmount, reference]
      );

      await client.query("COMMIT");

      res.json({
        ok: true,
        credited: creditedAmount,
        asset: AMT_ASSET_CODE,
        txHash,
        message:
          `${creditedAmount} on-chain ${AMT_ASSET_CODE} deposited → in-app AMT credited.`
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (e) {}
      console.error("DEPOSIT CLAIM ERROR:", error);

      if (
        error &&
        error.code === "23505"
      ) {
        return res.status(400).json({
          ok: false,
          error: "This transaction was already claimed."
        });
      }

      res.status(500).json({
        ok: false,
        error: "Unable to claim deposit."
      });
    } finally {
      client.release();
    }
  }
);

/* =========================================================
WALLET SEND
========================================================= */

async function performAmtTransfer(
  member,
  recipientAddress,
  amount,
  memo
) {
  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    await client.query(
      `
      SELECT id
      FROM members
      WHERE id = $1
      FOR UPDATE
      `,
      [member.id]
    );

    const senderWallet =
      await client.query(
        `
        SELECT
          id,
          member_id,
          wallet_address
        FROM amt_wallets
        WHERE member_id = $1
        FOR UPDATE
        `,
        [member.id]
      );

    if (
      !senderWallet.rows.length
    ) {
      throw new HttpError(
        404,
        "Sender wallet not found."
      );
    }

    // Accept AMT-... address OR Pi username / referral_code
    const rawRecipient = String(recipientAddress || "").trim();
    const asAddress = rawRecipient.toUpperCase();
    const asUser = rawRecipient.toLowerCase();

    let recipientWallet = await client.query(
      `
      SELECT
        w.id,
        w.member_id,
        w.wallet_address
      FROM amt_wallets w
      WHERE UPPER(w.wallet_address) = $1
      LIMIT 1
      FOR UPDATE
      `,
      [asAddress]
    );

    if (!recipientWallet.rows.length) {
      recipientWallet = await client.query(
        `
        SELECT
          w.id,
          w.member_id,
          w.wallet_address
        FROM amt_wallets w
        JOIN members m ON m.id = w.member_id
        WHERE LOWER(m.username) = $1
           OR LOWER(COALESCE(m.referral_code, '')) = $1
        LIMIT 1
        FOR UPDATE
        `,
        [asUser]
      );
    }

    if (
      !recipientWallet.rows.length
    ) {
      throw new HttpError(
        404,
        "Recipient not found. Use AMT address or Pi username (must have logged in to AMT app once)."
      );
    }

    const recipient =
      recipientWallet.rows[0];

    if (
      Number(
        recipient.member_id
      ) ===
      Number(member.id)
    ) {
      throw new HttpError(
        400,
        "You cannot send AMT to yourself."
      );
    }

    const balance =
      await getBalance(
        member.id,
        client
      );

    if (
      balance < amount
    ) {
      throw new HttpError(
        400,
        "Insufficient AMT balance.",
        {
          balance,
          requested:
            amount
        }
      );
    }

    const txId =
      makeReference(
        "AMT-TX"
      );

    await client.query(
      `
      INSERT INTO amt_transfers
        (
          tx_id,
          sender_member_id,
          recipient_member_id,
          amount,
          memo,
          status
        )
      VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          'COMPLETED'
        )
      `,
      [
        txId,
        member.id,
        recipient.member_id,
        amount,
        memo
      ]
    );

    await client.query(
      `
      INSERT INTO amt_ledger
        (
          member_id,
          amount,
          type,
          reference
        )
      VALUES
        (
          $1,
          $2,
          'SEND',
          $3
        )
      `,
      [
        member.id,
        -amount,
        txId + ":SEND"
      ]
    );

    await client.query(
      `
      INSERT INTO amt_ledger
        (
          member_id,
          amount,
          type,
          reference
        )
      VALUES
        (
          $1,
          $2,
          'RECEIVE',
          $3
        )
      `,
      [
        recipient.member_id,
        amount,
        txId + ":RECEIVE"
      ]
    );

    await client.query(
      "COMMIT"
    );

    const newBalance =
      await getBalance(
        member.id
      );

    return {
      txId,
      amount,
      recipientAddress,
      memo,
      balance:
        newBalance,
      status:
        "COMPLETED"
    };

  } catch (error) {
    try {
      await client.query(
        "ROLLBACK"
      );
    } catch {}

    throw error;

  } finally {
    client.release();
  }
}

app.post(
  "/api/wallet/send",
  requireAuth,
  async (req, res) => {
    const recipientAddress =
      String(
        req.body?.recipientAddress ||
        ""
      )
        .trim()
        .toUpperCase();

    const amount =
      validAmount(
        req.body?.amount
      );

    const memo =
      String(
        req.body?.memo || ""
      )
        .trim()
        .slice(0, 160);

    if (!recipientAddress) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Recipient AMT address is required."
        });
    }

    if (amount === null) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Invalid amount. Maximum 8 decimal places."
        });
    }

    try {
      const result =
        await performAmtTransfer(
          req.member,
          recipientAddress,
          amount,
          memo
        );

      res.json({
        ok: true,
        ...result,
        network:
          "Pi Mainnet",
        walletType:
          "AMT_MAINNET_LEDGER"
      });

    } catch (error) {
      console.error(
        "SEND AMT ERROR:",
        error
      );

      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,
          error:
            error.message ||
            "AMT transfer failed.",
          ...(error.extra || {})
        });
    }
  }
);

/* =========================================================
WALLET TRANSACTIONS
========================================================= */

app.get(
  "/api/wallet/transactions",
  requireAuth,
  async (req, res) => {
    try {
      // Peer transfers
      const result = await pool.query(
        `
        SELECT
          t.tx_id,
          t.amount,
          t.memo,
          t.status,
          t.created_at,
          t.sender_member_id,
          t.recipient_member_id,
          sw.wallet_address AS sender_address,
          rw.wallet_address AS recipient_address,
          sm.username AS sender_username,
          rm.username AS recipient_username
        FROM amt_transfers t
        JOIN amt_wallets sw ON sw.member_id = t.sender_member_id
        JOIN amt_wallets rw ON rw.member_id = t.recipient_member_id
        LEFT JOIN members sm ON sm.id = t.sender_member_id
        LEFT JOIN members rm ON rm.id = t.recipient_member_id
        WHERE t.sender_member_id = $1 OR t.recipient_member_id = $1
        ORDER BY t.created_at DESC
        LIMIT 50
        `,
        [req.member.id]
      );

      const transfers = result.rows.map((row) => {
        const isSend = Number(row.sender_member_id) === Number(req.member.id);
        const amt = Math.abs(Number(row.amount) || 0);
        const senderUser = row.sender_username ? String(row.sender_username) : null;
        const recipientUser = row.recipient_username ? String(row.recipient_username) : null;
        return {
          kind: "TRANSFER",
          txId: row.tx_id,
          amount: isSend ? -amt : amt,
          memo: row.memo || (isSend ? "Sent AMT" : "Received AMT"),
          status: row.status,
          createdAt: row.created_at,
          direction: isSend ? "SEND" : "RECEIVE",
          label: isSend ? "SEND AMT" : "RECEIVE AMT",
          senderAddress: row.sender_address,
          recipientAddress: row.recipient_address,
          senderUsername: senderUser,
          recipientUsername: recipientUser,
          counterpartyUsername: isSend ? recipientUser : senderUser,
          counterpartyAddress: isSend ? row.recipient_address : row.sender_address
        };
      });

      // Ledger rewards / activity + pet / market spends
      let rewards = [];
      try {
        const led = await pool.query(
          `
          SELECT id, amount, type, reference, created_at
          FROM amt_ledger
          WHERE member_id = $1
            AND type IN (
              'LUCKY_SPIN','DAILY','DAILY_REWARD','AIRDROP',
              'MINING','MINING_CLAIM','AD_BONUS','REFERRAL',
              'PET_PURCHASE','PET_BUY_LISTING','PET_SALE','EGG_BUY','EGG_SALE','ESCROW_HOLD','ESCROW_RELEASE',
              'PET_CARE','PET_RESCUE','PET_STAR','PET_TRAIN','PET_BREED','PET_BOSS','PET_TRADE',
              'GEAR_BUY','GEM_BUY','CORE_BUY','WEAPON_BUY',
              'MYSTERY_CHEST','DAILY_GOAL_BONUS','DUNGEON_LOOT','MISSION','MISSION_BONUS','STAKING_PAYOUT','STAKING_EARLY_WITHDRAW'
            )
          ORDER BY created_at DESC
          LIMIT 80
          `,
          [req.member.id]
        );
        // Enrich escrow rows with counterparty username (who you bought from / sold to)
        const escrowRefs = led.rows
          .filter((r) => r.type === "ESCROW_HOLD" || r.type === "ESCROW_RELEASE")
          .map((r) => r.reference)
          .filter(Boolean);
        const escrowMap = {};
        if (escrowRefs.length) {
          try {
            const er = await pool.query(
              `SELECT e.hold_ref, e.release_ref, e.listing_kind, e.price_amt,
                      e.buyer_member_id, e.seller_member_id,
                      b.username AS buyer_username,
                      s.username AS seller_username
               FROM market_escrows e
               LEFT JOIN members b ON b.id = e.buyer_member_id
               LEFT JOIN members s ON s.id = e.seller_member_id
               WHERE e.hold_ref = ANY($1::text[]) OR e.release_ref = ANY($1::text[])`,
              [escrowRefs]
            );
            for (const row of er.rows) {
              if (row.hold_ref) escrowMap[row.hold_ref] = row;
              if (row.release_ref) escrowMap[row.release_ref] = row;
            }
          } catch (eEsc) {
            console.warn("escrow enrich:", eEsc.message);
          }
        }

        rewards = led.rows.map((row) => {
          const typ = String(row.type || "REWARD");
          let label = typ;
          let kind = "REWARD";
          let memoExtra = "";
          if (typ === "LUCKY_SPIN") label = "LUCKY SPIN";
          else if (typ === "DAILY" || typ === "DAILY_REWARD") label = "DAILY REWARD";
          else if (typ === "MYSTERY_CHEST") label = "MYSTERY CHEST";
          else if (typ === "DUNGEON_LOOT") label = "DUNGEON LOOT";
          else if (typ === "WAR_LOOT") label = "WAR LOOT";
          else if (typ === "WAR_UPGRADE") label = "WAR UPGRADE";
          else if (typ === "WAR_REPAIR") label = "WAR REPAIR";
          else if (typ === "DAILY_GOAL_BONUS") label = "DAILY GOALS BONUS";
          else if (typ === "MISSION" || typ === "MISSION_BONUS") label = "DAILY MISSION";
          else if (typ === "STAKING_PAYOUT") label = "STAKING PAYOUT";
          else if (typ === "STAKING_EARLY_WITHDRAW") label = "STAKING EARLY WITHDRAW";
          else if (typ === "AIRDROP") label = "AIRDROP";
          else if (typ === "AD_BONUS") label = "AD BONUS";
          else if (typ === "REFERRAL") label = "REFERRAL";
          else if (typ === "MINING" || typ === "MINING_CLAIM") label = "MINING";
          else if (typ === "PET_PURCHASE") { label = "PET BUY (AMT)"; kind = "PET"; }
          else if (typ === "PET_BUY_LISTING") { label = "PET BUY LISTING"; kind = "PET"; }
          else if (typ === "PET_SALE") { label = "PET SALE"; kind = "PET"; }
          else if (typ === "ESCROW_HOLD") {
            kind = "PET";
            const info = escrowMap[row.reference] || {};
            const seller = info.seller_username || "seller";
            const what = info.listing_kind === "EGG" ? "Egg" : "Pet";
            label = "BUY " + what + " FROM @" + seller;
            memoExtra = "Escrow · from @" + seller;
          }
          else if (typ === "ESCROW_RELEASE") {
            kind = "PET";
            const info = escrowMap[row.reference] || {};
            const buyer = info.buyer_username || "buyer";
            const what = info.listing_kind === "EGG" ? "Egg" : "Pet";
            label = "SOLD " + what + " TO @" + buyer;
            memoExtra = "Escrow · to @" + buyer;
          }
          else if (typ === "EGG_BUY") { label = "EGG BUY"; kind = "PET"; }
          else if (typ === "EGG_SALE") { label = "EGG SALE"; kind = "PET"; }
          else if (typ === "SEND") { label = "SEND AMT"; kind = "SEND"; }
          else if (typ === "RECEIVE") { label = "RECEIVE AMT"; kind = "RECEIVE"; }
          else if (typ === "PET_TRADE") { label = "PET TRADE"; kind = "PET"; }
          else if (typ === "PET_CARE") { label = "PET CARE"; kind = "PET"; }
          else if (typ === "PET_RESCUE") { label = "PET RESCUE"; kind = "PET"; }
          else if (typ === "PET_STAR") { label = "STAR UPGRADE"; kind = "PET"; }
          else if (typ === "PET_TRAIN") { label = "PET TRAIN"; kind = "PET"; }
          else if (typ === "PET_BREED") { label = "PET BREED"; kind = "PET"; }
          else if (typ === "PET_BOSS") { label = "BOSS BATTLE"; kind = "PET"; }
          else if (typ.indexOf("BUY") >= 0 || typ.indexOf("GEAR") >= 0) { label = typ.replace(/_/g, " "); kind = "SHOP"; }
          return {
            kind: kind,
            type: typ,
            label: label,
            currency: "AMT",
            txId: row.reference || ("LEDGER-" + row.id),
            amount: Number(row.amount),
            memo: memoExtra || (label + (row.reference ? " · " + row.reference : "")),
            status: "OK",
            createdAt: row.created_at,
            direction: Number(row.amount) >= 0 ? "RECEIVE" : "SEND"
          };
        });
      } catch (ledErr) {
        console.warn("ledger history:", ledErr.message);
      }

      // Pi marketplace payments (pet buys with real Pi)
      let piPays = [];
      try {
        const pays = await pool.query(
          `
          SELECT id, pi_payment_id, product_id, amount, status, created_at, updated_at
          FROM marketplace_payments
          WHERE member_id = $1
          ORDER BY COALESCE(updated_at, created_at) DESC
          LIMIT 40
          `,
          [req.member.id]
        );
        piPays = pays.rows.map((row) => {
          const st = String(row.status || "").toUpperCase();
          const prod = String(row.product_id || "item");
          let label = "PI PAYMENT";
          if (/pet/i.test(prod)) label = "PET BUY (PI)";
          else if (/egg/i.test(prod)) label = "EGG BUY (PI)";
          else label = "BUY (PI) · " + prod;
          return {
            kind: "PI_PAY",
            type: "PI_PAYMENT",
            label: label,
            currency: "PI",
            txId: row.pi_payment_id || ("PI-" + row.id),
            amount: -Math.abs(Number(row.amount) || 0),
            memo: label + " · " + st + (prod ? " · " + prod : ""),
            status: st || "OK",
            createdAt: row.updated_at || row.created_at,
            direction: "SEND"
          };
        });
      } catch (payErr) {
        console.warn("pi payment history:", payErr.message);
      }

      const mergedRaw = transfers.concat(rewards).concat(piPays).sort((a, b) => {
        const ta = new Date(a.createdAt || 0).getTime();
        const tb = new Date(b.createdAt || 0).getTime();
        return tb - ta;
      });
      // Dedupe: same transfer can appear as amt_transfers + ledger SEND/RECEIVE
      const seen = new Set();
      const merged = [];
      for (const tx of mergedRaw) {
        const id = String(tx.txId || "").replace(/:SEND$/i, "").replace(/:RECEIVE$/i, "").toUpperCase();
        const key = id + "|" + String(tx.direction || tx.kind || "") + "|" + String(Math.abs(Number(tx.amount) || 0));
        if (id && seen.has(key)) continue;
        if (id) seen.add(key);
        merged.push(tx);
        if (merged.length >= 80) break;
      }

      res.json({ ok: true, transactions: merged });
    } catch (e) {
      console.error("TX HISTORY:", e);
      res.status(500).json({ ok: false, error: "Unable to load transactions." });
    }
  }
);

/* =========================================================
AIRDROP (100 AMT + 48-hour claim timer)
========================================================= */

app.get(
  "/api/airdrop/status",
  requireAuth,
  async (req, res) => {
    const result =
      await pool.query(
        `
        SELECT
          amount,
          reference,
          created_at
        FROM amt_airdrops
        WHERE member_id = $1
        LIMIT 1
        `,
        [req.member.id]
      );

    /*
     * Old 1 AMT claims are ignored.
     * Only a claim with amount >= current AIRDROP_AMOUNT_AMT (100)
     * counts as truly claimed.
     */
    let claimed = false;
    let claimedAt = null;
    let claimedAmount = null;

    if (result.rows.length > 0) {
      const row = result.rows[0];
      const oldAmount = Number(row.amount);

      if (oldAmount >= AIRDROP_AMOUNT_AMT) {
        claimed = true;
        claimedAt = row.created_at;
        claimedAmount = oldAmount;
      }
      // else: old 1 AMT claim → treat as NOT claimed (can claim 100)
    }

    // Shared 48-hour campaign window (not per-account created_at)
    const expiresAt =
      AIRDROP_CAMPAIGN_START_MS +
      AIRDROP_CLAIM_WINDOW_SECONDS *
        1000;

    const now =
      Date.now();

    const remainingSeconds =
      Math.max(
        0,
        Math.ceil(
          (expiresAt - now) /
            1000
        )
      );

    const expired =
      now >= expiresAt;

    const canClaim =
      !claimed && !expired;

    res.json({
      ok: true,

      claimed,

      amount:
        AIRDROP_AMOUNT_AMT,

      network:
        "Pi Mainnet",

      type:
        "ONE_TIME_AIRDROP",

      claimWindowSeconds:
        AIRDROP_CLAIM_WINDOW_SECONDS,

      remainingSeconds,

      expired,

      canClaim,

      expiresAt:
        new Date(
          expiresAt
        ).toISOString(),

      claimedAt,

      claimedAmount
    });
  }
);

app.post(
  "/api/airdrop/claim",
  requireAuth,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      await client.query(
        `
        SELECT id, created_at
        FROM members
        WHERE id = $1
        FOR UPDATE
        `,
        [req.member.id]
      );

      // Shared 48-hour campaign window
      const expiresAt =
        AIRDROP_CAMPAIGN_START_MS +
        AIRDROP_CLAIM_WINDOW_SECONDS *
          1000;

      if (
        Date.now() >= expiresAt
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Airdrop claim window has expired.",
            expired: true
          });
      }

      const existing =
        await client.query(
          `
          SELECT id, amount
          FROM amt_airdrops
          WHERE member_id = $1
          FOR UPDATE
          `,
          [req.member.id]
        );

      if (
        existing.rows.length
      ) {
        const oldAmount =
          Number(
            existing.rows[0].amount
          );

        // Already claimed the new 100 AMT airdrop
        if (
          oldAmount >=
          AIRDROP_AMOUNT_AMT
        ) {
          await client.query(
            "ROLLBACK"
          );

          return res
            .status(409)
            .json({
              ok: false,
              error:
                "Airdrop has already been claimed."
            });
        }

        // Old 1 AMT claim → remove it so user can claim 100 AMT
        await client.query(
          `
          DELETE FROM amt_airdrops
          WHERE member_id = $1
          `,
          [req.member.id]
        );
      }

      const reference =
        makeReference(
          "AMT-AIRDROP"
        );

      await client.query(
        `
        INSERT INTO amt_airdrops
          (
            member_id,
            amount,
            reference
          )
        VALUES
          (
            $1,
            $2,
            $3
          )
        `,
        [
          req.member.id,
          AIRDROP_AMOUNT_AMT,
          reference
        ]
      );

      await client.query(
        `
        INSERT INTO amt_ledger
          (
            member_id,
            amount,
            type,
            reference
          )
        VALUES
          (
            $1,
            $2,
            'AIRDROP_REWARD',
            $3
          )
        `,
        [
          req.member.id,
          AIRDROP_AMOUNT_AMT,
          reference
        ]
      );

      await client.query(
        "COMMIT"
      );

      const balance =
        await getBalance(
          req.member.id
        );

      const remainingSeconds =
        Math.max(
          0,
          Math.ceil(
            (expiresAt -
              Date.now()) /
              1000
          )
        );

      res.json({
        ok: true,

        claimed:
          true,

        amount:
          AIRDROP_AMOUNT_AMT,

        reference,

        balance,

        remainingSeconds,

        network:
          "Pi Mainnet"
      });

    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "AIRDROP ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to claim airdrop."
        });

    } finally {
      client.release();
    }
  }
);

/* =========================================================
MINING
========================================================= */

app.post(
  "/api/mining/start",
  requireAuth,
  async (req, res) => {
    const active =
      await pool.query(
        `
        SELECT *
        FROM mining_sessions
        WHERE
          member_id = $1
          AND status = 'ACTIVE'
        ORDER BY
          started_at DESC
        LIMIT 1
        `,
        [req.member.id]
      );

    if (
      active.rows.length
    ) {
      return res
        .status(409)
        .json({
          ok: false,
          error:
            "Mining session is already active.",
          session:
            active.rows[0]
        });
    }

    const start =
      new Date();

    const end =
      new Date(
        start.getTime() +
        MINING_DURATION_SECONDS *
          1000
      );

    const result =
      await pool.query(
        `
        INSERT INTO mining_sessions
          (
            member_id,
            started_at,
            ends_at,
            status,
            rate,
            claimed_amount
          )
        VALUES
          (
            $1,
            $2,
            $3,
            'ACTIVE',
            $4,
            0
          )

        RETURNING *
        `,
        [
          req.member.id,
          start,
          end,
          AMT_MINING_RATE
        ]
      );

    try { await bumpMission(req.member.id, "mine", 1); } catch (_) {}

    res.json({
      ok: true,

      session:
        result.rows[0],

      rate:
        AMT_MINING_RATE,

      durationSeconds:
        MINING_DURATION_SECONDS,

      maximumBaseReward:
        MAXIMUM_BASE_REWARD
    });
  }
);

app.get(
  "/api/mining/status",
  requireAuth,
  async (req, res) => {
    const result =
      await pool.query(
        `
        SELECT *
        FROM mining_sessions
        WHERE
          member_id = $1
          AND status = 'ACTIVE'
        ORDER BY
          started_at DESC
        LIMIT 1
        `,
        [req.member.id]
      );

    const balance =
      await getBalance(
        req.member.id
      );

    if (
      !result.rows.length
    ) {
      return res.json({
        ok: true,

        active:
          false,

        completed:
          false,

        earned:
          0,

        balance
      });
    }

    const session =
      result.rows[0];

    const started =
      new Date(
        session.started_at
      ).getTime();

    const ends =
      new Date(
        session.ends_at
      ).getTime();

    const current =
      Date.now();

    const elapsedSeconds =
      Math.max(
        0,
        Math.min(
          MINING_DURATION_SECONDS,
          (current - started) /
            1000
        )
      );

    const earned =
      Math.min(
        MAXIMUM_BASE_REWARD,
        Number(
          (
            elapsedSeconds /
              3600 *
            Number(
              session.rate
            )
          ).toFixed(8)
        )
      );

    const completed =
      current >= ends;

    res.json({
      ok: true,

      active:
        true,

      completed,

      session,

      earned,

      balance,

      rate:
        Number(
          session.rate
        ),

      remainingSeconds:
        Math.max(
          0,
          Math.ceil(
            (ends - current) /
              1000
          )
        )
    });
  }
);

app.post(
  "/api/mining/claim",
  requireAuth,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      await client.query(
        `
        SELECT id
        FROM members
        WHERE id = $1
        FOR UPDATE
        `,
        [req.member.id]
      );

      const sessionResult =
        await client.query(
          `
          SELECT *
          FROM mining_sessions
          WHERE
            member_id = $1
            AND status = 'ACTIVE'
          ORDER BY
            started_at DESC
          LIMIT 1
          FOR UPDATE
          `,
          [req.member.id]
        );

      if (
        !sessionResult.rows.length
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(404)
          .json({
            ok: false,
            error:
              "No active mining session."
          });
      }

      const session =
        sessionResult.rows[0];

      const ends =
        new Date(
          session.ends_at
        ).getTime();

      if (
        Date.now() < ends
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(400)
          .json({
            ok: false,

            error:
              "Mining session is not yet complete.",

            remainingSeconds:
              Math.ceil(
                (ends -
                  Date.now()) /
                  1000
              )
          });
      }

      let reward =
        Number(
          (
            Number(
              session.rate
            ) * 24
          ).toFixed(8)
        );

      // Comeback bonus if idle 3+ days since last completed claim
      let comebackBonus = 0;
      try {
        const last = await client.query(
          `SELECT claimed_amount, ends_at FROM mining_sessions
           WHERE member_id = $1 AND status = 'COMPLETED'
           ORDER BY ends_at DESC LIMIT 1`,
          [req.member.id]
        );
        if (last.rows.length) {
          const lastEnd = new Date(last.rows[0].ends_at).getTime();
          const idleDays = (Date.now() - lastEnd) / (24 * 3600 * 1000);
          if (idleDays >= COMEBACK_IDLE_DAYS) {
            comebackBonus = COMEBACK_BONUS_AMT;
            reward = Number((reward + comebackBonus).toFixed(8));
          }
        }
      } catch (e) {
        console.error("COMEBACK CHECK:", e.message);
      }

      const reference =
        makeReference(
          "AMT-MINING"
        );

      await client.query(
        `
        INSERT INTO amt_ledger
          (
            member_id,
            amount,
            type,
            reference
          )
        VALUES
          (
            $1,
            $2,
            'MINING_REWARD',
            $3
          )
        `,
        [
          req.member.id,
          reward,
          reference
        ]
      );

      await client.query(
        `
        UPDATE mining_sessions
        SET
          status = 'COMPLETED',
          claimed_amount = $1
        WHERE id = $2
        `,
        [
          reward,
          session.id
        ]
      );

      await client.query(
        "COMMIT"
      );
      try { await bumpMission(req.member.id, "mine", 1); } catch (_) {}

      const balance =
        await getBalance(
          req.member.id
        );

      res.json({
        ok: true,
        reward,
        comebackBonus,
        reference,
        balance,
        status: "COMPLETED",
        message:
          comebackBonus > 0
            ? "Mining +" +
              reward +
              " AMT (includes +" +
              comebackBonus +
              " comeback bonus)"
            : "Mining +" + reward + " AMT claimed"
      });

    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "MINING CLAIM ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to claim mining reward."
        });

    } finally {
      client.release();
    }
  }
);

/* =========================================================
DAILY REWARD (1x per UTC day + streak)
========================================================= */

app.get("/api/daily/status", requireAuth, async (req, res) => {
  try {
    await ensureDailyRewardTable();
    const today = utcDateString();
    const yesterday = yesterdayUtcString();

    const hist = await pool.query(
      `SELECT claim_date, amount, streak, created_at
       FROM daily_rewards
       WHERE member_id = $1
       ORDER BY claim_date DESC
       LIMIT 14`,
      [req.member.id]
    );

    let streak = 0;
    let claimedToday = false;
    let lastClaimDate = null;
    let lastAmount = null;

    if (hist.rows.length) {
      const row = hist.rows[0];
      lastClaimDate = asYmd(row.claim_date);
      lastAmount = Number(row.amount);
      const dates = hist.rows.map((r) => asYmd(r.claim_date));
      if (lastClaimDate === today) {
        claimedToday = true;
        streak = streakFromClaimDates(dates, today) || Number(row.streak) || 1;
      } else if (lastClaimDate === yesterday) {
        streak = streakFromClaimDates(dates, yesterday) || Number(row.streak) || 1;
      } else {
        streak = 0;
      }
    }

    let nextStreak;
    let displayAmount;
    if (claimedToday) {
      // Already claimed: streak is today's day; tomorrow continues or resets
      if ((streak || 0) >= DAILY_MAX_STREAK) {
        nextStreak = 1; // cycle complete → tomorrow Day 1
      } else {
        nextStreak = Math.min(DAILY_MAX_STREAK, (streak || 0) + 1);
      }
      displayAmount = lastAmount != null ? lastAmount : dailyAmountForStreak(streak || 1);
    } else if ((streak || 0) >= DAILY_MAX_STREAK) {
      // Finished 7-day cycle, not yet claimed today — start Day 1
      nextStreak = 1;
      displayAmount = dailyAmountForStreak(1);
    } else {
      nextStreak = Math.min(DAILY_MAX_STREAK, (streak || 0) + 1);
      displayAmount = dailyAmountForStreak(nextStreak);
    }
    const nextAmount = dailyAmountForStreak(nextStreak);

    // Next claim available at next UTC midnight if already claimed
    let nextClaimAt = null;
    let secondsUntilReset = 0;
    if (claimedToday) {
      const now = new Date();
      const next = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0, 0, 0, 0
      ));
      nextClaimAt = next.toISOString();
      secondsUntilReset = Math.max(0, Math.ceil((next.getTime() - now.getTime()) / 1000));
    }

    res.json({
      ok: true,
      claimedToday,
      streak: claimedToday ? streak : streak,
      nextStreak,
      nextAmount,
      displayAmount: displayAmount != null ? displayAmount : nextAmount,
      cycleComplete: claimedToday && (streak || 0) >= DAILY_MAX_STREAK,
      lastClaimDate,
      lastAmount,
      nextClaimAt,
      secondsUntilReset,
      maxStreak: DAILY_MAX_STREAK,
      schedule: DAILY_REWARD_AMOUNTS,
      canClaim: !claimedToday
    });
  } catch (e) {
    console.error("DAILY STATUS ERROR:", e);
    res.status(500).json({ ok: false, error: "Unable to load daily reward." });
  }
});

app.post("/api/daily/claim", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureDailyRewardTable();
    await client.query("BEGIN");
    await client.query(`SELECT id FROM members WHERE id = $1 FOR UPDATE`, [req.member.id]);

    const today = utcDateString();
    const yesterday = yesterdayUtcString();

    const existing = await client.query(
      `SELECT id FROM daily_rewards WHERE member_id = $1 AND claim_date = $2`,
      [req.member.id, today]
    );
    if (existing.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "Daily reward already claimed today. Come back after UTC midnight."
      });
    }

    const last = await client.query(
      `SELECT claim_date, streak FROM daily_rewards
       WHERE member_id = $1 ORDER BY claim_date DESC LIMIT 1`,
      [req.member.id]
    );

    // Build streak from actual consecutive claim days (repairs old streak=1 rows)
    const hist = await client.query(
      `SELECT claim_date FROM daily_rewards
       WHERE member_id = $1
       ORDER BY claim_date DESC
       LIMIT 14`,
      [req.member.id]
    );
    const pastDates = hist.rows.map((r) => asYmd(r.claim_date));
    // After full 7-day cycle, reset to Day 1 (not permanent max reward)
    let streak = 1;
    if (pastDates.includes(yesterday)) {
      const prior = streakFromClaimDates(pastDates, yesterday) || 1;
      if (prior >= DAILY_MAX_STREAK) {
        streak = 1;
      } else {
        streak = Math.min(DAILY_MAX_STREAK, prior + 1);
      }
    } else {
      streak = 1;
    }

    const amount = dailyAmountForStreak(streak);
    const reference = makeReference("AMT-DAILY");

    await client.query(
      `INSERT INTO daily_rewards (member_id, claim_date, amount, streak)
       VALUES ($1, $2, $3, $4)`,
      [req.member.id, today, amount, streak]
    );
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference)
       VALUES ($1, $2, 'DAILY_REWARD', $3)`,
      [req.member.id, amount, reference]
    );

    await client.query("COMMIT");
    const balance = await getBalance(req.member.id);

    res.json({
      ok: true,
      claimed: true,
      amount,
      streak,
      claimDate: today,
      reference,
      balance,
      message: "Daily reward +" + amount + " AMT · Streak " + streak + "/" + DAILY_MAX_STREAK
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("DAILY CLAIM ERROR:", e);
    res.status(500).json({
      ok: false,
      error: "Unable to claim daily reward. " + (e.message || "")
    });
  } finally {
    client.release();
  }
});

/* =========================================================
REFERRAL
========================================================= */

/** Both-sides welcome bonus when a referral is first linked */
const REFERRAL_INVITEE_BONUS = Number(
  process.env.REFERRAL_INVITEE_BONUS || "2"
);
const REFERRAL_INVITER_FLAT = Number(
  process.env.REFERRAL_INVITER_FLAT || "2"
);

/**
 * Credit referral reward + milestone bonus to the referrer,
 * and fixed welcome AMT to the invitee (both sides).
 */
async function creditReferralReward(
  referrerMemberId,
  newReferralCount,
  db = pool,
  referredMemberId = null
) {
  const tier = getReferralTier(newReferralCount);
  const reward = Number(
    Math.max(tier.rewardPerReferral, REFERRAL_INVITER_FLAT).toFixed(8)
  );
  const results = {
    tier: tier.name,
    referralReward: reward,
    milestoneBonus: 0,
    inviteeBonus: 0,
    totalCredited: 0
  };

  if (reward > 0) {
    const ref = makeReference("AMT-REF");
    await db.query(
      `
      INSERT INTO amt_ledger
        (member_id, amount, type, reference)
      VALUES
        ($1, $2, 'REFERRAL_REWARD', $3)
      `,
      [referrerMemberId, reward, ref]
    );
    results.totalCredited += reward;
  }

  // Invitee both-sides bonus (one-time per referred member)
  if (referredMemberId && REFERRAL_INVITEE_BONUS > 0) {
    const invRef = `AMT-REF-INVITEE-${referredMemberId}`;
    const existsInv = await db.query(
      `SELECT id FROM amt_ledger WHERE member_id = $1 AND reference = $2 LIMIT 1`,
      [referredMemberId, invRef]
    );
    if (!existsInv.rows.length) {
      await db.query(
        `INSERT INTO amt_ledger (member_id, amount, type, reference)
         VALUES ($1, $2, 'REFERRAL_INVITEE', $3)`,
        [referredMemberId, REFERRAL_INVITEE_BONUS, invRef]
      );
      results.inviteeBonus = REFERRAL_INVITEE_BONUS;
    }
  }

  // Check milestones (one-time)
  for (const mile of REFERRAL_MILESTONES) {
    if (newReferralCount >= mile.count) {
      const mileRef = `AMT-MILESTONE-${mile.key}-${referrerMemberId}`;

      const existing = await db.query(
        `
        SELECT id FROM amt_ledger
        WHERE member_id = $1 AND reference = $2
        LIMIT 1
        `,
        [referrerMemberId, mileRef]
      );

      if (!existing.rows.length) {
        await db.query(
          `
          INSERT INTO amt_ledger
            (member_id, amount, type, reference)
          VALUES
            ($1, $2, 'REFERRAL_MILESTONE', $3)
          `,
          [referrerMemberId, mile.bonus, mileRef]
        );
        results.milestoneBonus += mile.bonus;
        results.totalCredited += mile.bonus;
      }
    }
  }

  return results;
}

async function addReferralToSecurityCircle(
  client,
  ownerMemberId,
  referredMemberId
) {
  if (
    Number(ownerMemberId) ===
    Number(referredMemberId)
  ) {
    return false;
  }

  const countResult =
    await client.query(
      `
      SELECT
        COUNT(*)::INT AS count
      FROM security_circle
      WHERE
        owner_member_id = $1
        AND status = 'ACTIVE'
      `,
      [ownerMemberId]
    );

  const count =
    Number(
      countResult.rows[0]?.count || 0
    );

  const existing =
    await client.query(
      `
      SELECT id
      FROM security_circle
      WHERE
        owner_member_id = $1
        AND member_id = $2
      LIMIT 1
      `,
      [
        ownerMemberId,
        referredMemberId
      ]
    );

  if (
    existing.rows.length
  ) {
    await client.query(
      `
      UPDATE security_circle
      SET status = 'ACTIVE'
      WHERE id = $1
      `,
      [
        existing.rows[0].id
      ]
    );

    return true;
  }

  if (
    count >=
    MAX_SECURITY_CIRCLE
  ) {
    return false;
  }

  await client.query(
    `
    INSERT INTO security_circle
      (
        owner_member_id,
        member_id,
        status
      )
    VALUES
      (
        $1,
        $2,
        'ACTIVE'
      )
    `,
    [
      ownerMemberId,
      referredMemberId
    ]
  );

  return true;
}

app.post(
  "/api/referral/link",
  requireAuth,
  async (req, res) => {
    const referredMemberId =
      Number(
        req.body?.referralMemberId
      );

    if (
      !Number.isInteger(
        referredMemberId
      )
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Valid referralMemberId is required."
        });
    }

    if (
      referredMemberId ===
      Number(req.member.id)
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "You cannot refer yourself."
        });
    }

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      const memberCheck =
        await client.query(
          `
          SELECT id
          FROM members
          WHERE id = $1
          LIMIT 1
          `,
          [referredMemberId]
        );

      if (
        !memberCheck.rows.length
      ) {
        throw new HttpError(
          404,
          "Pioneer member was not found."
        );
      }

      const existing =
        await client.query(
          `
          SELECT id
          FROM referrals
          WHERE
            referred_member_id = $1
          LIMIT 1
          `,
          [referredMemberId]
        );

      if (
        existing.rows.length
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(409)
          .json({
            ok: false,
            error:
              "This Pioneer already has a referrer."
          });
      }

      await client.query(
        `
        INSERT INTO referrals
          (
            referrer_member_id,
            referred_member_id,
            status
          )
        VALUES
          (
            $1,
            $2,
            'ACTIVE'
          )
        `,
        [
          req.member.id,
          referredMemberId
        ]
      );

      const addedToCircle =
        await addReferralToSecurityCircle(
          client,
          req.member.id,
          referredMemberId
        );

      const countRes = await client.query(
        `
        SELECT COUNT(*)::INT AS count
        FROM referrals
        WHERE referrer_member_id = $1
          AND status = 'ACTIVE'
        `,
        [req.member.id]
      );
      const newCount = Number(countRes.rows[0]?.count || 0);

      const rewardInfo = await creditReferralReward(
        req.member.id,
        newCount,
        client,
        referredMemberId
      );

      await client.query(
        "COMMIT"
      );

      res.json({
        ok: true,

        linked:
          true,

        addedToSecurityCircle:
          addedToCircle,

        referralReward: rewardInfo
      });

    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      if (
        error.code ===
        "23505"
      ) {
        return res
          .status(409)
          .json({
            ok: false,
            error:
              "Referral is already linked."
          });
      }

      console.error(
        "REFERRAL ERROR:",
        error
      );

      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,
          error:
            error.message ||
            "Unable to link referral."
        });

    } finally {
      client.release();
    }
  }
);

app.post(
  "/api/referral/auto-link",
  async (req, res) => {
    try {
      const token =
        String(
          req.body?.accessToken || ""
        ).trim();

      const referralUsername =
        cleanUsername(
          req.body?.referralUsername
        );

      if (!token) {
        return res
          .status(401)
          .json({
            ok: false,
            error:
              "Pi access token is required."
          });
      }

      if (!referralUsername) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Referral username is required."
          });
      }

      const auth =
        await getAuthenticatedMember(
          token
        );

      const client =
        await pool.connect();

      try {
        await client.query(
          "BEGIN"
        );

        const referrer =
          await client.query(
            `
            SELECT *
            FROM members
            WHERE
              LOWER(username) =
              LOWER($1)
            LIMIT 1
            `,
            [referralUsername]
          );

        if (
          !referrer.rows.length
        ) {
          await client.query(
            "ROLLBACK"
          );

          return res
            .status(404)
            .json({
              ok: false,
              error:
                "Referral username not found."
            });
        }

        const referrerMember =
          referrer.rows[0];

        if (
          Number(
            referrerMember.id
          ) ===
          Number(
            auth.member.id
          )
        ) {
          await client.query(
            "ROLLBACK"
          );

          return res
            .status(400)
            .json({
              ok: false,
              error:
                "You cannot use your own username."
            });
        }

        const existing =
          await client.query(
            `
            SELECT *
            FROM referrals
            WHERE
              referred_member_id = $1
            LIMIT 1
            `,
            [auth.member.id]
          );

        if (
          existing.rows.length
        ) {
          await client.query(
            "ROLLBACK"
          );

          return res.json({
            ok: true,
            linked: false,
            alreadyLinked:
              true
          });
        }

        await client.query(
          `
          INSERT INTO referrals
            (
              referrer_member_id,
              referred_member_id,
              status
            )
          VALUES
            (
              $1,
              $2,
              'ACTIVE'
            )
          `,
          [
            referrerMember.id,
            auth.member.id
          ]
        );

        const addedToCircle =
          await addReferralToSecurityCircle(
            client,
            referrerMember.id,
            auth.member.id
          );

        // Count after this new referral
        const countRes = await client.query(
          `
          SELECT COUNT(*)::INT AS count
          FROM referrals
          WHERE referrer_member_id = $1
            AND status = 'ACTIVE'
          `,
          [referrerMember.id]
        );
        const newCount = Number(countRes.rows[0]?.count || 0);

        const rewardInfo = await creditReferralReward(
          referrerMember.id,
          newCount,
          client,
          auth.member.id
        );

        await client.query(
          "COMMIT"
        );

        return res.json({
          ok: true,

          linked:
            true,

          referrerUsername:
            referrerMember.username,

          addedToSecurityCircle:
            addedToCircle,

          referralReward: rewardInfo
        });

      } catch (error) {
        try {
          await client.query(
            "ROLLBACK"
          );
        } catch {}

        throw error;

      } finally {
        client.release();
      }

    } catch (error) {
      console.error(
        "AUTO REFERRAL ERROR:",
        error
      );

      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,
          error:
            error.message ||
            "Unable to auto-link referral."
        });
    }
  }
);

app.get(
  "/api/referral/status",
  requireAuth,
  async (req, res) => {
    const countResult =
      await pool.query(
        `
        SELECT
          COUNT(*)::INT AS count
        FROM referrals
        WHERE
          referrer_member_id = $1
          AND status = 'ACTIVE'
        `,
        [req.member.id]
      );

    const activeMiners =
      await pool.query(
        `
        SELECT
          COUNT(*)::INT AS count
        FROM referrals r
        JOIN mining_sessions ms
          ON ms.member_id =
             r.referred_member_id
        WHERE
          r.referrer_member_id = $1
          AND r.status = 'ACTIVE'
          AND ms.status = 'ACTIVE'
          AND NOW() < ms.ends_at
        `,
        [req.member.id]
      );

    const referrals =
      await pool.query(
        `
        SELECT

          m.username,
          m.pi_uid,
          r.status,
          r.created_at,

          EXISTS (
            SELECT 1
            FROM mining_sessions ms
            WHERE
              ms.member_id = m.id
              AND ms.status = 'ACTIVE'
              AND NOW() < ms.ends_at
          ) AS mining

        FROM referrals r

        JOIN members m
          ON m.id =
             r.referred_member_id

        WHERE
          r.referrer_member_id = $1

        ORDER BY
          r.created_at DESC
        `,
        [req.member.id]
      );

    const referralCount = Number(
      countResult.rows[0]?.count || 0
    );
    const currentTier = getReferralTier(referralCount);

    res.json({
      ok: true,

      username:
        req.member.username,

      // Referral code of this Pioneer (saved from Pi username on login)
      // This is what other miners should use when joining
      referralCode:
        req.member.referral_code ||
        req.member.username ||
        null,

      referralCount,

      maxDirectReferrals:
        "UNLIMITED",

      activeMiners:
        Number(
          activeMiners.rows[0]?.count || 0
        ),

      // Tier system info
      tier: {
        name: currentTier.name,
        rewardPerReferral: currentTier.rewardPerReferral,
        min: currentTier.min,
        max: currentTier.max === Infinity ? null : currentTier.max
      },

      tiers: REFERRAL_TIERS.map(t => ({
        name: t.name,
        min: t.min,
        max: t.max === Infinity ? null : t.max,
        rewardPerReferral: t.rewardPerReferral
      })),

      milestones: REFERRAL_MILESTONES,

      referrals:
        referrals.rows
    });
  }
);

/* =========================================================
SECURITY CIRCLE
========================================================= */

app.post(
  "/api/security-circle/add",
  requireAuth,
  async (req, res) => {
    const memberId =
      Number(
        req.body?.memberId
      );

    if (
      !Number.isInteger(
        memberId
      )
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Valid memberId is required."
        });
    }

    if (
      memberId ===
      Number(req.member.id)
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "You cannot add yourself."
        });
    }

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      const memberCheck =
        await client.query(
          `
          SELECT id
          FROM members
          WHERE id = $1
          LIMIT 1
          `,
          [memberId]
        );

      if (
        !memberCheck.rows.length
      ) {
        throw new HttpError(
          404,
          "Pioneer member was not found."
        );
      }

      const added =
        await addReferralToSecurityCircle(
          client,
          req.member.id,
          memberId
        );

      if (!added) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(409)
          .json({
            ok: false,
            error:
              "Security Circle is full. Maximum 5 members."
          });
      }

      await client.query(
        "COMMIT"
      );

      res.json({
        ok: true,
        added: true
      });

    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "SECURITY ADD ERROR:",
        error
      );

      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,
          error:
            error.message ||
            "Unable to add Security Circle member."
        });

    } finally {
      client.release();
    }
  }
);

app.get(
  "/api/security-circle/status",
  requireAuth,
  async (req, res) => {
    const result =
      await pool.query(
        `
        SELECT

          m.id,
          m.username,
          m.pi_uid,

          sc.status,
          sc.created_at,

          EXISTS (
            SELECT 1
            FROM mining_sessions ms
            WHERE
              ms.member_id = m.id
              AND ms.status = 'ACTIVE'
              AND NOW() < ms.ends_at
          ) AS mining

        FROM security_circle sc

        JOIN members m
          ON m.id =
             sc.member_id

        WHERE
          sc.owner_member_id = $1
          AND sc.status = 'ACTIVE'

        ORDER BY
          sc.created_at ASC
        `,
        [req.member.id]
      );

    res.json({
      ok: true,

      maxMembers:
        MAX_SECURITY_CIRCLE,

      count:
        result.rows.length,

      members:
        result.rows
    });
  }
);

/* =========================================================
STAKING POOLS
========================================================= */

app.get(
  "/api/staking/pools",
  async (req, res) => {
    res.json({
      ok: true,

      network:
        "Pi Mainnet",

      environment:
        "MAINNET",

      minimumStake:
        STAKING_MIN_AMOUNT_AMT,

      compounding:
        false,

      pools:
        Object.values(
          STAKING_POOLS
        )
    });
  }
);

/* =========================================================
STAKING STATUS
========================================================= */

app.get(
  "/api/staking/status",
  requireAuth,
  async (req, res) => {
    try {
      const balance =
        await getBalance(
          req.member.id
        );

      const summary =
        await getStakingSummary(
          req.member.id
        );

      const result =
        await pool.query(
          `
          SELECT

            id,
            pool_id,
            principal,
            reward_rate,
            reward_amount,
            started_at,
            unlock_at,
            status,
            unstaked_at,
            created_at

          FROM amt_stakes

          WHERE member_id = $1

          ORDER BY
            created_at DESC

          LIMIT 100
          `,
          [req.member.id]
        );

      const stakes =
        result.rows.map(
          stake => {
            const poolInfo =
              STAKING_POOLS[
                stake.pool_id
              ];

            const unlockTime =
              new Date(
                stake.unlock_at
              ).getTime();

            const unlocked =
              Date.now() >=
              unlockTime;

            const remainingSeconds =
              Math.max(
                0,
                Math.ceil(
                  (
                    unlockTime -
                    Date.now()
                  ) / 1000
                )
              );

            return {
              id:
                stake.id,

              poolId:
                stake.pool_id,

              poolName:
                poolInfo?.name ||
                stake.pool_id,

              lockDays:
                poolInfo?.lockDays ||
                null,

              rewardPercent:
                Number(
                  stake.reward_rate
                ),

              principal:
                Number(
                  stake.principal
                ),

              reward:
                Number(
                  stake.reward_amount
                ),

              totalAtUnlock:
                Number(
                  (
                    Number(
                      stake.principal
                    ) +
                    Number(
                      stake.reward_amount
                    )
                  ).toFixed(8)
                ),

              startedAt:
                stake.started_at,

              unlockAt:
                stake.unlock_at,

              remainingSeconds,

              unlocked,

              status:
                stake.status,

              canUnstake:
                stake.status ===
                  "ACTIVE" &&
                unlocked,

              unstakedAt:
                stake.unstaked_at,

              createdAt:
                stake.created_at
            };
          }
        );

      const portfolioBalance =
        Number(
          (
            balance +
            summary.stakedPrincipal
          ).toFixed(8)
        );

      res.json({
        ok: true,

        network:
          "Pi Mainnet",

        environment:
          "MAINNET",

        minimumStake:
          STAKING_MIN_AMOUNT_AMT,

        availableBalance:
          balance,

        stakedPrincipal:
          summary.stakedPrincipal,

        pendingRewards:
          summary.pendingRewards,

        portfolioBalance,

        activeStakeCount:
          stakes.filter(
            stake =>
              stake.status ===
              "ACTIVE"
          ).length,

        pools:
          Object.values(
            STAKING_POOLS
          ),

        stakes
      });

    } catch (error) {
      console.error(
        "STAKING STATUS ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to load staking status."
        });
    }
  }
);

/* =========================================================
CREATE STAKE
========================================================= */

app.post(
  "/api/staking/stake",
  requireAuth,
  async (req, res) => {
    const poolId =
      String(
        req.body?.poolId || ""
      )
        .trim()
        .toUpperCase();

    const amount =
      validAmount(
        req.body?.amount
      );

    const selectedPool =
      STAKING_POOLS[
        poolId
      ];

    if (!selectedPool) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Invalid staking pool."
        });
    }

    if (amount === null) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Invalid AMT amount."
        });
    }

    if (
      amount <
      STAKING_MIN_AMOUNT_AMT
    ) {
      return res
        .status(400)
        .json({
          ok: false,

          error:
            `Minimum stake is ${STAKING_MIN_AMOUNT_AMT} AMT.`
        });
    }

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      await client.query(
        `
        SELECT id
        FROM members
        WHERE id = $1
        FOR UPDATE
        `,
        [req.member.id]
      );

      const balance =
        await getBalance(
          req.member.id,
          client
        );

      if (
        balance < amount
      ) {
        throw new HttpError(
          400,
          "Insufficient AMT balance.",
          {
            balance,
            requested:
              amount
          }
        );
      }

      const rewardRate =
        selectedPool
          .rewardPercent / 100;

      const reward =
        Number(
          (
            amount *
            rewardRate
          ).toFixed(8)
        );

      const startedAt =
        new Date();

      const unlockAt =
        new Date(
          startedAt.getTime() +
          selectedPool.lockDays *
            24 *
            60 *
            60 *
            1000
        );

      const reference =
        makeReference(
          "AMT-STAKE"
        );

      const stakeResult =
        await client.query(
          `
          INSERT INTO amt_stakes
            (
              member_id,
              pool_id,
              principal,
              reward_rate,
              reward_amount,
              started_at,
              unlock_at,
              status
            )
          VALUES
            (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              'ACTIVE'
            )

          RETURNING *
          `,
          [
            req.member.id,
            selectedPool.id,
            amount,
            rewardRate,
            reward,
            startedAt,
            unlockAt
          ]
        );

      await client.query(
        `
        INSERT INTO amt_ledger
          (
            member_id,
            amount,
            type,
            reference
          )
        VALUES
          (
            $1,
            $2,
            'STAKING_LOCK',
            $3
          )
        `,
        [
          req.member.id,
          -amount,
          reference
        ]
      );

      await client.query(
        "COMMIT"
      );

      const newBalance =
        await getBalance(
          req.member.id
        );

      res.json({
        ok: true,

        staked:
          true,

        stake: {
          id:
            stakeResult.rows[0].id,

          poolId:
            selectedPool.id,

          poolName:
            selectedPool.name,

          lockDays:
            selectedPool.lockDays,

          principal:
            amount,

          rewardPercent:
            selectedPool.rewardPercent,

          reward,

          totalAtUnlock:
            Number(
              (
                amount +
                reward
              ).toFixed(8)
            ),

          startedAt,

          unlockAt,

          status:
            "ACTIVE"
        },

        balance:
          newBalance,

        network:
          "Pi Mainnet",

        environment:
          "MAINNET"
      });

    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "STAKE ERROR:",
        error
      );

      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,

          error:
            error.message ||
            "Unable to create stake.",

          ...(error.extra || {})
        });

    } finally {
      client.release();
    }
  }
);

/* =========================================================
UNSTAKE
========================================================= */

app.post(
  "/api/staking/unstake",
  requireAuth,
  async (req, res) => {
    const stakeId =
      Number(
        req.body?.stakeId
      );

    if (
      !Number.isInteger(
        stakeId
      ) ||
      stakeId <= 0
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Valid stakeId is required."
        });
    }

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      await client.query(
        `
        SELECT id
        FROM members
        WHERE id = $1
        FOR UPDATE
        `,
        [req.member.id]
      );

      const stakeResult =
        await client.query(
          `
          SELECT *
          FROM amt_stakes
          WHERE
            id = $1
            AND member_id = $2
          FOR UPDATE
          `,
          [
            stakeId,
            req.member.id
          ]
        );

      if (
        !stakeResult.rows.length
      ) {
        throw new HttpError(
          404,
          "Stake not found."
        );
      }

      const stake =
        stakeResult.rows[0];

      if (
        stake.status !==
        "ACTIVE"
      ) {
        throw new HttpError(
          409,
          "This stake has already been processed."
        );
      }

      const unlockTime =
        new Date(
          stake.unlock_at
        ).getTime();

      const principal =
        Number(
          stake.principal
        );

      const fullReward =
        Number(
          stake.reward_amount
        );

      // Early withdraw allowed: principal only (forfeit reward)
      // After unlock: principal + full reward
      const isEarly = Date.now() < unlockTime;
      const reward = isEarly ? 0 : fullReward;

      const total =
        Number(
          (
            principal +
            reward
          ).toFixed(8)
        );

      const reference =
        makeReference(
          isEarly ? "AMT-UNSTAKE-EARLY" : "AMT-UNSTAKE"
        );

      await client.query(
        `
        INSERT INTO amt_ledger
          (
            member_id,
            amount,
            type,
            reference
          )
        VALUES
          (
            $1,
            $2,
            $3,
            $4
          )
        `,
        [
          req.member.id,
          total,
          isEarly ? "STAKING_EARLY_WITHDRAW" : "STAKING_PAYOUT",
          reference
        ]
      );

      await client.query(
        `
        UPDATE amt_stakes
        SET
          status = $2,
          unstaked_at = NOW()
        WHERE id = $1
        `,
        [stakeId, isEarly ? "EARLY_WITHDRAWN" : "COMPLETED"]
      );

      await client.query(
        "COMMIT"
      );

      const balance =
        await getBalance(
          req.member.id
        );

      res.json({
        ok: true,

        unstaked:
          true,

        early: isEarly,

        stakeId,

        principal,

        reward,

        rewardForfeited: isEarly ? fullReward : 0,

        total,

        reference,

        balance,

        status:
          isEarly ? "EARLY_WITHDRAWN" : "COMPLETED",

        message: isEarly
          ? ("Early withdraw · +" + principal + " AMT principal returned · reward forfeited")
          : ("Unstaked · +" + total + " AMT (principal + reward)"),

        network:
          "Pi Mainnet",

        environment:
          "MAINNET"
      });

    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "UNSTAKE ERROR:",
        error
      );

      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,

          error:
            error.message ||
            "Unable to unstake.",

          ...(error.extra || {})
        });

    } finally {
      client.release();
    }
  }
);

/* =========================================================
STAKING HISTORY
========================================================= */

app.get(
  "/api/staking/history",
  requireAuth,
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT

            id,
            pool_id,
            principal,
            reward_rate,
            reward_amount,
            started_at,
            unlock_at,
            status,
            unstaked_at,
            created_at

          FROM amt_stakes

          WHERE member_id = $1

          ORDER BY
            created_at DESC

          LIMIT 100
          `,
          [req.member.id]
        );

      const history =
        result.rows.map(
          stake => ({
            id:
              stake.id,

            poolId:
              stake.pool_id,

            pool:
              STAKING_POOLS[
                stake.pool_id
              ] || null,

            principal:
              Number(
                stake.principal
              ),

            rewardPercent:
              Number(
                stake.reward_rate
              ),

            reward:
              Number(
                stake.reward_amount
              ),

            total:
              Number(
                (
                  Number(
                    stake.principal
                  ) +
                  Number(
                    stake.reward_amount
                  )
                ).toFixed(8)
              ),

            startedAt:
              stake.started_at,

            unlockAt:
              stake.unlock_at,

            status:
              stake.status,

            unstakedAt:
              stake.unstaked_at,

            createdAt:
              stake.created_at
          })
        );

      res.json({
        ok: true,

        network:
          "Pi Mainnet",

        history
      });

    } catch (error) {
      console.error(
        "STAKING HISTORY ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to load staking history."
        });
    }
  }
);

/* =========================================================
AMT PET MARKETPLACE + FULL PET SYSTEM (v2.4.0)
========================================================= */

const PET_ELEMENTS = [
  "Earth", "Water", "Nature", "Ice", "Fire", "Wind", "Thunder", "Shadow", "Light", "Cosmic"
];

const PET_RARITIES = [
  "Common",
  "Uncommon",
  "Rare",
  "Epic",
  "Legendary",
  "Mythic"
];

/* Level → max rarity pioneers can reach by training/battling */
function rarityRank(r) {
  const i = PET_RARITIES.indexOf(String(r || "Common"));
  return i < 0 ? 0 : i;
}

function petTitle(level, stars, rarity) {
  const lv = Math.max(1, Number(level) || 1);
  const st = Math.max(1, Math.min(5, Number(stars != null ? stars : 1)));
  const r = String(rarity || rarityFromLevel(lv) || "Common");
  if (r === "Mythic" && st >= 5 && lv >= 60) return "Mythic Ace";
  if (r === "Mythic" && st >= 5) return "Mythic ★5";
  if (r === "Mythic") return "Mythic";
  if (r === "Legendary" && st >= 5) return "Legend Ace";
  if (r === "Legendary") return "Legendary";
  if (r === "Epic" && st >= 5) return "Epic Ace";
  if (st >= 5) return "★5 Champion";
  if (lv >= 40) return "Veteran";
  if (lv >= 20) return "Fighter";
  return "";
}

function rarityFromLevel(level) {
  const lv = Math.max(1, Number(level) || 1);
  if (lv >= 100) return "Ascendant";
  if (lv >= 50) return "Mythic";
  if (lv >= 40) return "Legendary";
  if (lv >= 30) return "Epic";
  if (lv >= 20) return "Rare";
  if (lv >= 10) return "Uncommon";
  return "Common";
}
/** Option A: rarity is 100% from pet level (shop rarity = price tier only). */
function evolvedRarity(_baseRarity, level) {
  return rarityFromLevel(level);
}
const PET_LEVEL_MILESTONES = [
  { level: 10, amount: 2, key: "LV10" },
  { level: 20, amount: 5, key: "LV20" },
  { level: 50, amount: 15, key: "LV50" },
  { level: 100, amount: 25, key: "LV100" },
  { level: 150, amount: 50, key: "LV150" }
];

async function creditPetLevelMilestones(db, memberId, ownedId, newLevel) {
  const bonuses = [];
  for (const m of PET_LEVEL_MILESTONES) {
    if (newLevel < m.level) continue;
    const ref = `AMT-PET-LV-${m.key}-${ownedId}`;
    const exists = await db.query(
      `SELECT id FROM amt_ledger WHERE member_id = $1 AND reference = $2 LIMIT 1`,
      [memberId, ref]
    );
    if (exists.rows.length) continue;
    await db.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference)
       VALUES ($1, $2, 'PET_LEVEL_MILESTONE', $3)`,
      [memberId, m.amount, ref]
    );
    bonuses.push({ level: m.level, amount: m.amount });
  }
  return bonuses;
}

async function applyLevelAndRarity(client, ownedId, memberId) {
  const db = client || pool;
  const row = await db.query(
    `SELECT id, level, exp, member_id FROM owned_pets WHERE id = $1`,
    [ownedId]
  );
  if (!row.rows.length) return null;
  let { level, exp } = row.rows[0];
  const ownerId = memberId || row.rows[0].member_id;
  const oldLevel = Number(level) || 1;
  level = oldLevel;
  exp = Number(exp) || 0;
  // Multi level-up if lots of exp (max Lv 150)
  // Cost scales: pre-99 = level*50, post-99 = level*80 (slower endgame)
  const MAX_PET_LEVEL = 150;
  while (level < MAX_PET_LEVEL) {
    const need = level < 99 ? level * 50 : level * 80;
    if (exp < need) break;
    exp -= need;
    level += 1;
  }
  const newRarity = rarityFromLevel(level);
  const updated = await db.query(
    `UPDATE owned_pets SET level = $1, exp = $2, rarity = $3
     WHERE id = $4 RETURNING *`,
    [level, exp, newRarity, ownedId]
  );
  let milestones = [];
  if (level > oldLevel && ownerId) {
    try {
      milestones = await creditPetLevelMilestones(db, ownerId, ownedId, level);
    } catch (e) {
      console.error("PET LEVEL MILESTONE:", e.message || e);
    }
  }
  const pet = updated.rows[0];
  if (pet) pet._milestones = milestones;
  return pet;
}

const AMT_PETS = [
  {
    "id": "earth-rock-puppy",
    "name": "Rock Puppy",
    "element": "Earth",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 90,
    "atk": 12,
    "def": 20,
    "spd": 8,
    "ability": "Stone Guard",
    "image": "assets/pets/common/earth-rock-puppy.png",
    "number": 1
  },
  {
    "id": "earth-mud-turtle",
    "name": "Mud Turtle",
    "element": "Earth",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 93,
    "atk": 13,
    "def": 21,
    "spd": 9,
    "ability": "Stone Guard",
    "image": "assets/pets/common/earth-mud-turtle.png",
    "number": 2
  },
  {
    "id": "earth-mountain-bear",
    "name": "Mountain Bear",
    "element": "Earth",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 96,
    "atk": 15,
    "def": 23,
    "spd": 10,
    "ability": "Stone Guard",
    "image": "assets/pets/common/earth-mountain-bear.png",
    "number": 3
  },
  {
    "id": "earth-crystal-wolf",
    "name": "Crystal Wolf",
    "element": "Earth",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 99,
    "atk": 16,
    "def": 24,
    "spd": 11,
    "ability": "Stone Guard",
    "image": "assets/pets/common/earth-crystal-wolf.png",
    "number": 4
  },
  {
    "id": "earth-terra-dragon",
    "name": "Terra Dragon",
    "element": "Earth",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 102,
    "atk": 18,
    "def": 26,
    "spd": 12,
    "ability": "Stone Guard",
    "image": "assets/pets/common/earth-terra-dragon.png",
    "number": 5
  },
  {
    "id": "earth-golem",
    "name": "Golem",
    "element": "Earth",
    "rarity": "Uncommon",
    "priceAmt": 1.5,
    "hp": 105,
    "atk": 19,
    "def": 27,
    "spd": 13,
    "ability": "Stone Guard",
    "image": "assets/pets/common/earth-golem.png",
    "number": 6
  },
  {
    "id": "earth-sand-cat",
    "name": "Sand Cat",
    "element": "Earth",
    "rarity": "Uncommon",
    "priceAmt": 1.5,
    "hp": 108,
    "atk": 21,
    "def": 29,
    "spd": 14,
    "ability": "Stone Guard",
    "image": "assets/pets/common/earth-sand-cat.png",
    "number": 7
  },
  {
    "id": "earth-clay-puppy",
    "name": "Clay Puppy",
    "element": "Earth",
    "rarity": "Rare",
    "priceAmt": 4.0,
    "hp": 111,
    "atk": 22,
    "def": 30,
    "spd": 15,
    "ability": "Stone Guard",
    "image": "assets/pets/common/earth-clay-puppy.png",
    "number": 8
  },
  {
    "id": "earth-emerald-snake",
    "name": "Emerald Snake",
    "element": "Earth",
    "rarity": "Epic",
    "priceAmt": 12.0,
    "hp": 114,
    "atk": 24,
    "def": 32,
    "spd": 16,
    "ability": "Stone Guard",
    "image": "assets/pets/common/earth-emerald-snake.png",
    "number": 9
  },
  {
    "id": "earth-gaia-titan",
    "name": "Gaia Titan",
    "element": "Earth",
    "rarity": "Legendary",
    "priceAmt": 40.0,
    "hp": 117,
    "atk": 25,
    "def": 33,
    "spd": 17,
    "ability": "Stone Guard",
    "image": "assets/pets/common/earth-gaia-titan.png",
    "number": 10
  },
  {
    "id": "water-bubble-puppy",
    "name": "Bubble Puppy",
    "element": "Water",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 85,
    "atk": 14,
    "def": 14,
    "spd": 12,
    "ability": "Tidal Pulse",
    "image": "assets/pets/common/water-bubble-puppy.png",
    "number": 1
  },
  {
    "id": "water-splash-turtle",
    "name": "Splash Turtle",
    "element": "Water",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 88,
    "atk": 15,
    "def": 15,
    "spd": 13,
    "ability": "Tidal Pulse",
    "image": "assets/pets/common/water-splash-turtle.png",
    "number": 2
  },
  {
    "id": "water-wave-wolf",
    "name": "Wave Wolf",
    "element": "Water",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 91,
    "atk": 17,
    "def": 17,
    "spd": 14,
    "ability": "Tidal Pulse",
    "image": "assets/pets/common/water-wave-wolf.png",
    "number": 3
  },
  {
    "id": "water-aqua-dragon",
    "name": "Aqua Dragon",
    "element": "Water",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 94,
    "atk": 18,
    "def": 18,
    "spd": 15,
    "ability": "Tidal Pulse",
    "image": "assets/pets/common/water-aqua-dragon.png",
    "number": 4
  },
  {
    "id": "water-coral-cat",
    "name": "Coral Cat",
    "element": "Water",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 97,
    "atk": 20,
    "def": 20,
    "spd": 16,
    "ability": "Tidal Pulse",
    "image": "assets/pets/common/water-coral-cat.png",
    "number": 5
  },
  {
    "id": "water-ice-seal",
    "name": "Ice Seal",
    "element": "Water",
    "rarity": "Uncommon",
    "priceAmt": 1.5,
    "hp": 100,
    "atk": 21,
    "def": 21,
    "spd": 17,
    "ability": "Tidal Pulse",
    "image": "assets/pets/common/water-ice-seal.png",
    "number": 6
  },
  {
    "id": "water-mermaid-puppy",
    "name": "Mermaid Puppy",
    "element": "Water",
    "rarity": "Uncommon",
    "priceAmt": 1.5,
    "hp": 103,
    "atk": 23,
    "def": 23,
    "spd": 18,
    "ability": "Tidal Pulse",
    "image": "assets/pets/common/water-mermaid-puppy.png",
    "number": 7
  },
  {
    "id": "water-kraken-baby",
    "name": "Kraken Baby",
    "element": "Water",
    "rarity": "Rare",
    "priceAmt": 4.0,
    "hp": 106,
    "atk": 24,
    "def": 24,
    "spd": 19,
    "ability": "Tidal Pulse",
    "image": "assets/pets/common/water-kraken-baby.png",
    "number": 8
  },
  {
    "id": "water-droplet-spirit",
    "name": "Droplet Spirit",
    "element": "Water",
    "rarity": "Epic",
    "priceAmt": 12.0,
    "hp": 109,
    "atk": 26,
    "def": 26,
    "spd": 20,
    "ability": "Tidal Pulse",
    "image": "assets/pets/common/water-droplet-spirit.png",
    "number": 9
  },
  {
    "id": "water-ocean-god",
    "name": "Ocean God",
    "element": "Water",
    "rarity": "Legendary",
    "priceAmt": 40.0,
    "hp": 112,
    "atk": 27,
    "def": 27,
    "spd": 21,
    "ability": "Tidal Pulse",
    "image": "assets/pets/common/water-ocean-god.png",
    "number": 10
  },
  {
    "id": "nature-leaf-puppy",
    "name": "Leaf Puppy",
    "element": "Nature",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 80,
    "atk": 13,
    "def": 15,
    "spd": 14,
    "ability": "Leaf Veil",
    "image": "assets/pets/common/nature-leaf-puppy.png",
    "number": 1
  },
  {
    "id": "nature-vine-snake",
    "name": "Vine Snake",
    "element": "Nature",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 83,
    "atk": 14,
    "def": 16,
    "spd": 15,
    "ability": "Leaf Veil",
    "image": "assets/pets/common/nature-vine-snake.png",
    "number": 2
  },
  {
    "id": "nature-forest-wolf",
    "name": "Forest Wolf",
    "element": "Nature",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 86,
    "atk": 16,
    "def": 18,
    "spd": 16,
    "ability": "Leaf Veil",
    "image": "assets/pets/common/nature-forest-wolf.png",
    "number": 3
  },
  {
    "id": "nature-bloom-dragon",
    "name": "Bloom Dragon",
    "element": "Nature",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 89,
    "atk": 17,
    "def": 19,
    "spd": 17,
    "ability": "Leaf Veil",
    "image": "assets/pets/common/nature-bloom-dragon.png",
    "number": 4
  },
  {
    "id": "nature-sprout-cat",
    "name": "Sprout Cat",
    "element": "Nature",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 92,
    "atk": 19,
    "def": 21,
    "spd": 18,
    "ability": "Leaf Veil",
    "image": "assets/pets/common/nature-sprout-cat.png",
    "number": 5
  },
  {
    "id": "nature-tree-golem",
    "name": "Tree Golem",
    "element": "Nature",
    "rarity": "Uncommon",
    "priceAmt": 1.5,
    "hp": 95,
    "atk": 20,
    "def": 22,
    "spd": 19,
    "ability": "Leaf Veil",
    "image": "assets/pets/common/nature-tree-golem.png",
    "number": 6
  },
  {
    "id": "nature-flower-puppy",
    "name": "Flower Puppy",
    "element": "Nature",
    "rarity": "Uncommon",
    "priceAmt": 1.5,
    "hp": 98,
    "atk": 22,
    "def": 24,
    "spd": 20,
    "ability": "Leaf Veil",
    "image": "assets/pets/common/nature-flower-puppy.png",
    "number": 7
  },
  {
    "id": "nature-jungle-tiger",
    "name": "Jungle Tiger",
    "element": "Nature",
    "rarity": "Rare",
    "priceAmt": 4.0,
    "hp": 101,
    "atk": 23,
    "def": 25,
    "spd": 21,
    "ability": "Leaf Veil",
    "image": "assets/pets/common/nature-jungle-tiger.png",
    "number": 8
  },
  {
    "id": "nature-herb-sheep",
    "name": "Herb Sheep",
    "element": "Nature",
    "rarity": "Epic",
    "priceAmt": 12.0,
    "hp": 104,
    "atk": 25,
    "def": 27,
    "spd": 22,
    "ability": "Leaf Veil",
    "image": "assets/pets/common/nature-herb-sheep.png",
    "number": 9
  },
  {
    "id": "nature-mother-earth",
    "name": "Mother Earth",
    "element": "Nature",
    "rarity": "Legendary",
    "priceAmt": 40.0,
    "hp": 107,
    "atk": 26,
    "def": 28,
    "spd": 23,
    "ability": "Leaf Veil",
    "image": "assets/pets/common/nature-mother-earth.png",
    "number": 10
  },
  {
    "id": "ice-snow-puppy",
    "name": "Snow Puppy",
    "element": "Ice",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 82,
    "atk": 13,
    "def": 16,
    "spd": 12,
    "ability": "Frost Armor",
    "image": "assets/pets/common/ice-snow-puppy.png",
    "number": 1
  },
  {
    "id": "ice-frost-fox",
    "name": "Frost Fox",
    "element": "Ice",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 85,
    "atk": 14,
    "def": 17,
    "spd": 13,
    "ability": "Frost Armor",
    "image": "assets/pets/common/ice-frost-fox.png",
    "number": 2
  },
  {
    "id": "ice-glacier-bear",
    "name": "Glacier Bear",
    "element": "Ice",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 88,
    "atk": 16,
    "def": 19,
    "spd": 14,
    "ability": "Frost Armor",
    "image": "assets/pets/common/ice-glacier-bear.png",
    "number": 3
  },
  {
    "id": "ice-ice-dragon",
    "name": "Ice Dragon",
    "element": "Ice",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 91,
    "atk": 17,
    "def": 20,
    "spd": 15,
    "ability": "Frost Armor",
    "image": "assets/pets/common/ice-ice-dragon.png",
    "number": 4
  },
  {
    "id": "ice-icicle-cat",
    "name": "Icicle Cat",
    "element": "Ice",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 94,
    "atk": 19,
    "def": 22,
    "spd": 16,
    "ability": "Frost Armor",
    "image": "assets/pets/common/ice-icicle-cat.png",
    "number": 5
  },
  {
    "id": "ice-snow-wolf",
    "name": "Snow Wolf",
    "element": "Ice",
    "rarity": "Uncommon",
    "priceAmt": 1.5,
    "hp": 97,
    "atk": 20,
    "def": 23,
    "spd": 17,
    "ability": "Frost Armor",
    "image": "assets/pets/common/ice-snow-wolf.png",
    "number": 6
  },
  {
    "id": "ice-frozen-turtle",
    "name": "Frozen Turtle",
    "element": "Ice",
    "rarity": "Uncommon",
    "priceAmt": 1.5,
    "hp": 100,
    "atk": 22,
    "def": 25,
    "spd": 18,
    "ability": "Frost Armor",
    "image": "assets/pets/common/ice-frozen-turtle.png",
    "number": 7
  },
  {
    "id": "ice-frost-sprite",
    "name": "Frost Sprite",
    "element": "Ice",
    "rarity": "Rare",
    "priceAmt": 4.0,
    "hp": 103,
    "atk": 23,
    "def": 26,
    "spd": 19,
    "ability": "Frost Armor",
    "image": "assets/pets/common/ice-frost-sprite.png",
    "number": 8
  },
  {
    "id": "ice-avalanche-golem",
    "name": "Avalanche Golem",
    "element": "Ice",
    "rarity": "Epic",
    "priceAmt": 12.0,
    "hp": 106,
    "atk": 25,
    "def": 28,
    "spd": 20,
    "ability": "Frost Armor",
    "image": "assets/pets/common/ice-avalanche-golem.png",
    "number": 9
  },
  {
    "id": "ice-winter-god",
    "name": "Winter God",
    "element": "Ice",
    "rarity": "Legendary",
    "priceAmt": 40.0,
    "hp": 109,
    "atk": 26,
    "def": 29,
    "spd": 21,
    "ability": "Frost Armor",
    "image": "assets/pets/common/ice-winter-god.png",
    "number": 10
  },
  {
    "id": "fire-ember-puppy",
    "name": "Ember Puppy",
    "element": "Fire",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 78,
    "atk": 18,
    "def": 12,
    "spd": 14,
    "ability": "Flame Burst",
    "image": "assets/pets/common/fire-ember-puppy.png",
    "number": 1
  },
  {
    "id": "fire-flame-fox",
    "name": "Flame Fox",
    "element": "Fire",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 81,
    "atk": 19,
    "def": 13,
    "spd": 15,
    "ability": "Flame Burst",
    "image": "assets/pets/common/fire-flame-fox.png",
    "number": 2
  },
  {
    "id": "fire-lava-turtle",
    "name": "Lava Turtle",
    "element": "Fire",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 84,
    "atk": 21,
    "def": 15,
    "spd": 16,
    "ability": "Flame Burst",
    "image": "assets/pets/common/fire-lava-turtle.png",
    "number": 3
  },
  {
    "id": "fire-inferno-wolf",
    "name": "Inferno Wolf",
    "element": "Fire",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 87,
    "atk": 22,
    "def": 16,
    "spd": 17,
    "ability": "Flame Burst",
    "image": "assets/pets/common/fire-inferno-wolf.png",
    "number": 4
  },
  {
    "id": "fire-blaze-dragon",
    "name": "Blaze Dragon",
    "element": "Fire",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 90,
    "atk": 24,
    "def": 18,
    "spd": 18,
    "ability": "Flame Burst",
    "image": "assets/pets/common/fire-blaze-dragon.png",
    "number": 5
  },
  {
    "id": "fire-cinder-cat",
    "name": "Cinder Cat",
    "element": "Fire",
    "rarity": "Uncommon",
    "priceAmt": 1.5,
    "hp": 93,
    "atk": 25,
    "def": 19,
    "spd": 19,
    "ability": "Flame Burst",
    "image": "assets/pets/common/fire-cinder-cat.png",
    "number": 6
  },
  {
    "id": "fire-magma-bear",
    "name": "Magma Bear",
    "element": "Fire",
    "rarity": "Uncommon",
    "priceAmt": 1.5,
    "hp": 96,
    "atk": 27,
    "def": 21,
    "spd": 20,
    "ability": "Flame Burst",
    "image": "assets/pets/common/fire-magma-bear.png",
    "number": 7
  },
  {
    "id": "fire-phoenix-chick",
    "name": "Phoenix Chick",
    "element": "Fire",
    "rarity": "Rare",
    "priceAmt": 4.0,
    "hp": 99,
    "atk": 28,
    "def": 22,
    "spd": 21,
    "ability": "Flame Burst",
    "image": "assets/pets/common/fire-phoenix-chick.png",
    "number": 8
  },
  {
    "id": "fire-spark-lizard",
    "name": "Spark Lizard",
    "element": "Fire",
    "rarity": "Epic",
    "priceAmt": 12.0,
    "hp": 102,
    "atk": 30,
    "def": 24,
    "spd": 22,
    "ability": "Flame Burst",
    "image": "assets/pets/common/fire-spark-lizard.png",
    "number": 9
  },
  {
    "id": "fire-volcano-golem",
    "name": "Volcano Golem",
    "element": "Fire",
    "rarity": "Legendary",
    "priceAmt": 40.0,
    "hp": 105,
    "atk": 31,
    "def": 25,
    "spd": 23,
    "ability": "Flame Burst",
    "image": "assets/pets/common/fire-volcano-golem.png",
    "number": 10
  },
  {
    "id": "wind-breeze-bunny",
    "name": "Breeze Bunny",
    "element": "Wind",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 75,
    "atk": 14,
    "def": 11,
    "spd": 20,
    "ability": "Gale Force",
    "image": "assets/pets/common/wind-breeze-bunny.png",
    "number": 1
  },
  {
    "id": "wind-gale-hawk",
    "name": "Gale Hawk",
    "element": "Wind",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 78,
    "atk": 15,
    "def": 12,
    "spd": 21,
    "ability": "Gale Force",
    "image": "assets/pets/common/wind-gale-hawk.png",
    "number": 2
  },
  {
    "id": "wind-storm-eagle",
    "name": "Storm Eagle",
    "element": "Wind",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 81,
    "atk": 17,
    "def": 14,
    "spd": 22,
    "ability": "Gale Force",
    "image": "assets/pets/common/wind-storm-eagle.png",
    "number": 3
  },
  {
    "id": "wind-zephyr-wolf",
    "name": "Zephyr Wolf",
    "element": "Wind",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 84,
    "atk": 18,
    "def": 15,
    "spd": 23,
    "ability": "Gale Force",
    "image": "assets/pets/common/wind-zephyr-wolf.png",
    "number": 4
  },
  {
    "id": "wind-tornado-dragon",
    "name": "Tornado Dragon",
    "element": "Wind",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 87,
    "atk": 20,
    "def": 17,
    "spd": 24,
    "ability": "Gale Force",
    "image": "assets/pets/common/wind-tornado-dragon.png",
    "number": 5
  },
  {
    "id": "wind-feather-cat",
    "name": "Feather Cat",
    "element": "Wind",
    "rarity": "Uncommon",
    "priceAmt": 1.5,
    "hp": 90,
    "atk": 21,
    "def": 18,
    "spd": 25,
    "ability": "Gale Force",
    "image": "assets/pets/common/wind-feather-cat.png",
    "number": 6
  },
  {
    "id": "wind-cyclone-horse",
    "name": "Cyclone Horse",
    "element": "Wind",
    "rarity": "Uncommon",
    "priceAmt": 1.5,
    "hp": 93,
    "atk": 23,
    "def": 20,
    "spd": 26,
    "ability": "Gale Force",
    "image": "assets/pets/common/wind-cyclone-horse.png",
    "number": 7
  },
  {
    "id": "wind-sky-whale",
    "name": "Sky Whale",
    "element": "Wind",
    "rarity": "Rare",
    "priceAmt": 4.0,
    "hp": 96,
    "atk": 24,
    "def": 21,
    "spd": 27,
    "ability": "Gale Force",
    "image": "assets/pets/common/wind-sky-whale.png",
    "number": 8
  },
  {
    "id": "wind-wind-sprite",
    "name": "Wind Sprite",
    "element": "Wind",
    "rarity": "Epic",
    "priceAmt": 12.0,
    "hp": 99,
    "atk": 26,
    "def": 23,
    "spd": 28,
    "ability": "Gale Force",
    "image": "assets/pets/common/wind-wind-sprite.png",
    "number": 9
  },
  {
    "id": "wind-tempest-god",
    "name": "Tempest God",
    "element": "Wind",
    "rarity": "Legendary",
    "priceAmt": 40.0,
    "hp": 102,
    "atk": 27,
    "def": 24,
    "spd": 29,
    "ability": "Gale Force",
    "image": "assets/pets/common/wind-tempest-god.png",
    "number": 10
  },
  {
    "id": "thunder-spark-puppy",
    "name": "Spark Puppy",
    "element": "Thunder",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 76,
    "atk": 17,
    "def": 11,
    "spd": 18,
    "ability": "Static Shock",
    "image": "assets/pets/common/thunder-spark-puppy.png",
    "number": 1
  },
  {
    "id": "thunder-bolt-fox",
    "name": "Bolt Fox",
    "element": "Thunder",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 79,
    "atk": 18,
    "def": 12,
    "spd": 19,
    "ability": "Static Shock",
    "image": "assets/pets/common/thunder-bolt-fox.png",
    "number": 2
  },
  {
    "id": "thunder-thunder-wolf",
    "name": "Thunder Wolf",
    "element": "Thunder",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 82,
    "atk": 20,
    "def": 14,
    "spd": 20,
    "ability": "Static Shock",
    "image": "assets/pets/common/thunder-thunder-wolf.png",
    "number": 3
  },
  {
    "id": "thunder-storm-dragon",
    "name": "Storm Dragon",
    "element": "Thunder",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 85,
    "atk": 21,
    "def": 15,
    "spd": 21,
    "ability": "Static Shock",
    "image": "assets/pets/common/thunder-storm-dragon.png",
    "number": 4
  },
  {
    "id": "thunder-zap-cat",
    "name": "Zap Cat",
    "element": "Thunder",
    "rarity": "Common",
    "priceAmt": 0.5,
    "hp": 88,
    "atk": 23,
    "def": 17,
    "spd": 22,
    "ability": "Static Shock",
    "image": "assets/pets/common/thunder-zap-cat.png",
    "number": 5
  },
  {
    "id": "thunder-lightning-horse",
    "name": "Lightning Horse",
    "element": "Thunder",
    "rarity": "Uncommon",
    "priceAmt": 1.5,
    "hp": 91,
    "atk": 24,
    "def": 18,
    "spd": 23,
    "ability": "Static Shock",
    "image": "assets/pets/common/thunder-lightning-horse.png",
    "number": 6
  },
  {
    "id": "thunder-static-puppy",
    "name": "Static Puppy",
    "element": "Thunder",
    "rarity": "Uncommon",
    "priceAmt": 1.5,
    "hp": 94,
    "atk": 26,
    "def": 20,
    "spd": 24,
    "ability": "Static Shock",
    "image": "assets/pets/common/thunder-static-puppy.png",
    "number": 7
  },
  {
    "id": "thunder-thunder-bear",
    "name": "Thunder Bear",
    "element": "Thunder",
    "rarity": "Rare",
    "priceAmt": 4.0,
    "hp": 97,
    "atk": 27,
    "def": 21,
    "spd": 25,
    "ability": "Static Shock",
    "image": "assets/pets/common/thunder-thunder-bear.png",
    "number": 8
  },
  {
    "id": "thunder-volt-lizard",
    "name": "Volt Lizard",
    "element": "Thunder",
    "rarity": "Epic",
    "priceAmt": 12.0,
    "hp": 100,
    "atk": 29,
    "def": 23,
    "spd": 26,
    "ability": "Static Shock",
    "image": "assets/pets/common/thunder-volt-lizard.png",
    "number": 9
  },
  {
    "id": "thunder-zeus-titan",
    "name": "Zeus Titan",
    "element": "Thunder",
    "rarity": "Legendary",
    "priceAmt": 40.0,
    "hp": 103,
    "atk": 30,
    "def": 24,
    "spd": 27,
    "ability": "Static Shock",
    "image": "assets/pets/common/thunder-zeus-titan.png",
    "number": 10
  }
  ,
  {
    "id": "premium-earth-guardian",
    "name": "Earth Guardian",
    "element": "Earth",
    "rarity": "Common",
    "priceAmt": 1.0,
    "hp": 110,
    "atk": 16,
    "def": 28,
    "spd": 10,
    "ability": "Strong Roots",
    "image": "amt_pet_earth.png",
    "tagline": "Strong Roots, Brighter Tomorrow.",
    "number": 101
  },
  {
    "id": "premium-water-spirit",
    "name": "Water Spirit",
    "element": "Water",
    "rarity": "Common",
    "priceAmt": 1.0,
    "hp": 100,
    "atk": 18,
    "def": 18,
    "spd": 16,
    "ability": "Flow Path",
    "image": "amt_pet_water.png",
    "tagline": "Flow with Change, Find Your Path.",
    "number": 102
  },
  {
    "id": "premium-nature-sprout",
    "name": "Nature Sprout",
    "element": "Nature",
    "rarity": "Common",
    "priceAmt": 1.0,
    "hp": 95,
    "atk": 17,
    "def": 17,
    "spd": 15,
    "ability": "Big Growth",
    "image": "amt_pet_nature.png",
    "tagline": "Small Steps, Big Growth.",
    "number": 103
  },
  {
    "id": "premium-ice-crystal",
    "name": "Ice Crystal",
    "element": "Ice",
    "rarity": "Common",
    "priceAmt": 1.0,
    "hp": 98,
    "atk": 19,
    "def": 16,
    "spd": 14,
    "ability": "Cool Mind",
    "image": "amt_pet_ice.png",
    "tagline": "Cool Mind, Strong Soul.",
    "number": 104
  },
  {
    "id": "premium-thunder-bolt",
    "name": "Thunder Bolt",
    "element": "Thunder",
    "rarity": "Common",
    "priceAmt": 1.0,
    "hp": 92,
    "atk": 24,
    "def": 14,
    "spd": 22,
    "ability": "Lightning Speed",
    "image": "amt_pet_thunder.png",
    "tagline": "Lightning Speed, Limitless Energy.",
    "number": 105
  },
  {
    "id": "premium-wind-flyer",
    "name": "Wind Flyer",
    "element": "Wind",
    "rarity": "Common",
    "priceAmt": 1.0,
    "hp": 90,
    "atk": 18,
    "def": 14,
    "spd": 26,
    "ability": "Fly Higher",
    "image": "amt_pet_wind.png",
    "tagline": "Fly Higher, Reach Further.",
    "number": 106
  },
  {
    "id": "premium-fire-ember",
    "name": "Fire Ember",
    "element": "Fire",
    "rarity": "Common",
    "priceAmt": 1.0,
    "hp": 94,
    "atk": 22,
    "def": 14,
    "spd": 18,
    "ability": "Small Flame",
    "image": "amt_pet_fire.png",
    "tagline": "Small Flame, Big Dreams.",
    "number": 107
  },
  {
    "id": "premium-shadow-wraith",
    "name": "Shadow Wraith",
    "element": "Shadow",
    "rarity": "Rare",
    "priceAmt": 5.0,
    "hp": 105,
    "atk": 28,
    "def": 18,
    "spd": 24,
    "ability": "Dark Strength",
    "image": "amt_pet_shadow.png",
    "tagline": "In the Darkness, We Find Strength.",
    "number": 108
  },
  {
    "id": "premium-light-angel",
    "name": "Light Angel",
    "element": "Light",
    "rarity": "Epic",
    "priceAmt": 15.0,
    "hp": 120,
    "atk": 30,
    "def": 22,
    "spd": 20,
    "ability": "Spread Light",
    "image": "amt_pet_light.png",
    "tagline": "Bring Hope, Spread Light.",
    "number": 109
  },
  {
    "id": "premium-cosmic-nova",
    "name": "Cosmic Nova",
    "element": "Cosmic",
    "rarity": "Legendary",
    "priceAmt": 45.0,
    "hp": 140,
    "atk": 35,
    "def": 28,
    "spd": 25,
    "ability": "Beyond Dimensions",
    "image": "amt_pet_cosmic.png",
    "tagline": "Beyond Dimensions, Together We Shine.",
    "number": 110
  }

];



/* =========================================================
   PET GEAR — wearable equipment (not emoji)
   SOURCE: Weapon/Gear STORE only (buy with AMT).
   GEAR LOOT DISABLED — no battle/story drops for now.
========================================================= */
const AMT_GEAR = [
  /* --- Swords --- */
  { id: "wpn_wood_blade", name: "Wood Blade", slot: "weapon", rarity: "Common", priceAmt: 0.8,
    atk: 4, def: 0, hp: 0, spd: 0, color: "#c4a574", shape: "sword", weaponType: "sword" },
  { id: "wpn_iron_sword", name: "Iron Sword", slot: "weapon", rarity: "Uncommon", priceAmt: 2.5,
    atk: 9, def: 0, hp: 0, spd: 1, color: "#9aa4b2", shape: "sword", weaponType: "sword" },
  { id: "wpn_flame_edge", name: "Flame Edge", slot: "weapon", rarity: "Rare", priceAmt: 8,
    atk: 16, def: 0, hp: 0, spd: 2, color: "#ff6b35", shape: "sword", weaponType: "sword" },
  { id: "wpn_cosmic_blade", name: "Cosmic Blade", slot: "weapon", rarity: "Legendary", priceAmt: 40,
    atk: 35, def: 5, hp: 10, spd: 5, color: "#b388ff", shape: "sword", weaponType: "sword" },
  /* --- Daggers --- */
  { id: "wpn_bone_dagger", name: "Bone Dagger", slot: "weapon", rarity: "Common", priceAmt: 0.7,
    atk: 3, def: 0, hp: 0, spd: 3, color: "#e0d5c0", shape: "dagger", weaponType: "dagger" },
  { id: "wpn_shadow_dagger", name: "Shadow Dagger", slot: "weapon", rarity: "Rare", priceAmt: 7.5,
    atk: 14, def: 0, hp: 0, spd: 8, color: "#7e57c2", shape: "dagger", weaponType: "dagger" },
  { id: "wpn_venom_fang", name: "Venom Fang", slot: "weapon", rarity: "Epic", priceAmt: 17,
    atk: 20, def: 0, hp: 0, spd: 10, color: "#69f0ae", shape: "dagger", weaponType: "dagger" },
  /* --- Axes --- */
  { id: "wpn_stone_axe", name: "Stone Axe", slot: "weapon", rarity: "Common", priceAmt: 0.9,
    atk: 5, def: 1, hp: 0, spd: -1, color: "#90a4ae", shape: "axe", weaponType: "axe" },
  { id: "wpn_war_axe", name: "War Axe", slot: "weapon", rarity: "Uncommon", priceAmt: 3,
    atk: 11, def: 2, hp: 5, spd: -1, color: "#ef5350", shape: "axe", weaponType: "axe" },
  { id: "wpn_berserker_axe", name: "Berserker Axe", slot: "weapon", rarity: "Epic", priceAmt: 19,
    atk: 26, def: 3, hp: 8, spd: 0, color: "#ff1744", shape: "axe", weaponType: "axe" },
  /* --- Bows --- */
  { id: "wpn_hunter_bow", name: "Hunter Bow", slot: "weapon", rarity: "Common", priceAmt: 0.9,
    atk: 4, def: 0, hp: 0, spd: 2, color: "#8d6e63", shape: "bow", weaponType: "bow" },
  { id: "wpn_wind_bow", name: "Wind Bow", slot: "weapon", rarity: "Rare", priceAmt: 8,
    atk: 15, def: 0, hp: 0, spd: 6, color: "#4fc3f7", shape: "bow", weaponType: "bow" },
  { id: "wpn_star_bow", name: "Star Bow", slot: "weapon", rarity: "Legendary", priceAmt: 38,
    atk: 30, def: 0, hp: 5, spd: 8, color: "#e1bee7", shape: "bow", weaponType: "bow" },
  /* --- Mage / staff --- */
  { id: "wpn_apprentice_staff", name: "Apprentice Staff", slot: "weapon", rarity: "Common", priceAmt: 0.85,
    atk: 3, def: 0, hp: 5, spd: 1, color: "#ce93d8", shape: "staff", weaponType: "staff" },
  { id: "wpn_arcane_staff", name: "Arcane Staff", slot: "weapon", rarity: "Rare", priceAmt: 9,
    atk: 14, def: 2, hp: 12, spd: 2, color: "#7c4dff", shape: "staff", weaponType: "staff" },
  { id: "wpn_crystal_wand", name: "Crystal Wand", slot: "weapon", rarity: "Uncommon", priceAmt: 2.8,
    atk: 8, def: 0, hp: 8, spd: 2, color: "#80d8ff", shape: "wand", weaponType: "wand" },
  { id: "wpn_void_staff", name: "Void Staff", slot: "weapon", rarity: "Legendary", priceAmt: 42,
    atk: 32, def: 4, hp: 15, spd: 4, color: "#ea80fc", shape: "staff", weaponType: "staff" },
  /* --- Spear / pole --- */
  { id: "wpn_thunder_spear", name: "Thunder Spear", slot: "weapon", rarity: "Epic", priceAmt: 18,
    atk: 24, def: 0, hp: 5, spd: 4, color: "#ffd93d", shape: "spear", weaponType: "spear" },
  { id: "wpn_halberd", name: "Iron Halberd", slot: "weapon", rarity: "Uncommon", priceAmt: 3.2,
    atk: 10, def: 3, hp: 0, spd: 0, color: "#b0bec5", shape: "halberd", weaponType: "halberd" },

  { id: "shd_wood_buckler", name: "Wood Buckler", slot: "shield", rarity: "Common", priceAmt: 0.8,
    atk: 0, def: 5, hp: 8, spd: 0, color: "#c4a574", shape: "shield" },
  { id: "shd_iron_guard", name: "Iron Guard", slot: "shield", rarity: "Uncommon", priceAmt: 2.5,
    atk: 0, def: 10, hp: 15, spd: 0, color: "#9aa4b2", shape: "shield" },
  { id: "shd_crystal_aegis", name: "Crystal Aegis", slot: "shield", rarity: "Rare", priceAmt: 8,
    atk: 0, def: 18, hp: 25, spd: 0, color: "#4fc3f7", shape: "shield" },

  { id: "hd_leather_cap", name: "Leather Cap", slot: "head", rarity: "Common", priceAmt: 0.6,
    atk: 0, def: 3, hp: 10, spd: 0, color: "#8d6e63", shape: "helm" },
  { id: "hd_iron_helm", name: "Iron Helm", slot: "head", rarity: "Uncommon", priceAmt: 2.2,
    atk: 1, def: 7, hp: 18, spd: 0, color: "#90a4ae", shape: "helm" },
  { id: "hd_crown_light", name: "Crown of Light", slot: "head", rarity: "Epic", priceAmt: 16,
    atk: 5, def: 10, hp: 30, spd: 2, color: "#ffe082", shape: "crown" },

  { id: "bd_cloth_vest", name: "Cloth Vest", slot: "body", rarity: "Common", priceAmt: 0.7,
    atk: 0, def: 4, hp: 12, spd: 0, color: "#81c784", shape: "armor" },
  { id: "bd_scale_mail", name: "Scale Mail", slot: "body", rarity: "Uncommon", priceAmt: 3,
    atk: 0, def: 12, hp: 28, spd: -1, color: "#66bb6a", shape: "armor" },
  { id: "bd_shadow_cloak", name: "Shadow Cloak", slot: "body", rarity: "Rare", priceAmt: 9,
    atk: 6, def: 10, hp: 20, spd: 5, color: "#7e57c2", shape: "cloak" },
  { id: "bd_cosmic_plate", name: "Cosmic Plate", slot: "body", rarity: "Legendary", priceAmt: 42,
    atk: 8, def: 22, hp: 45, spd: 2, color: "#ce93d8", shape: "armor" },

  { id: "bt_soft_paws", name: "Soft Paws", slot: "boots", rarity: "Common", priceAmt: 0.6,
    atk: 0, def: 1, hp: 5, spd: 4, color: "#a1887f", shape: "boots" },
  { id: "bt_wind_runners", name: "Wind Runners", slot: "boots", rarity: "Rare", priceAmt: 7,
    atk: 2, def: 2, hp: 8, spd: 12, color: "#4dd0e1", shape: "boots" },

  { id: "acc_power_ring", name: "Power Ring", slot: "accessory", rarity: "Uncommon", priceAmt: 2,
    atk: 5, def: 0, hp: 0, spd: 2, color: "#ff8a65", shape: "ring" },
  { id: "acc_guardian_amulet", name: "Guardian Amulet", slot: "accessory", rarity: "Rare", priceAmt: 7.5,
    atk: 0, def: 8, hp: 20, spd: 0, color: "#26c6da", shape: "amulet" },
  { id: "acc_mythic_orb", name: "Mythic Orb", slot: "accessory", rarity: "Legendary", priceAmt: 35,
    atk: 12, def: 12, hp: 25, spd: 6, color: "#ea80fc", shape: "orb" }
];

function getGearById(id) {
  return AMT_GEAR.find(g => g.id === id) || null;
}

async function ensureGearTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_inventory (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      gear_id TEXT NOT NULL,
      qty INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (member_id, gear_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_equipment (
      owned_pet_id BIGINT NOT NULL REFERENCES owned_pets(id) ON DELETE CASCADE,
      slot TEXT NOT NULL,
      gear_id TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (owned_pet_id, slot)
    )
  `);
  await pool.query(`ALTER TABLE pet_equipment ADD COLUMN IF NOT EXISTS upgrade_level INT NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE pet_equipment ADD COLUMN IF NOT EXISTS gem1 TEXT`);
  await pool.query(`ALTER TABLE pet_equipment ADD COLUMN IF NOT EXISTS gem2 TEXT`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_materials (
      member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      material_id TEXT NOT NULL,
      qty INT NOT NULL DEFAULT 0,
      PRIMARY KEY (member_id, material_id)
    )
  `);
}

const GEAR_MAX_UPGRADE = 15;

const AMT_MATERIALS = {
  pet_food: { id: "pet_food", name: "Pet Food", kind: "consumable", priceAmt: 0.2, desc: "Feed pet · +Hunger +Energy" },
  water_crystal: { id: "water_crystal", name: "Water Crystal", kind: "consumable", priceAmt: 0.15, desc: "Give water · +Thirst" },
  mineral_ore: { id: "mineral_ore", name: "Mineral Ore", kind: "material", priceAmt: 0.12, desc: "Star upgrade / map loot" },
  energy_shard: { id: "energy_shard", name: "Energy Shard", kind: "consumable", priceAmt: 0.3, desc: "Restore pet energy" },
  upgrade_core: { id: "upgrade_core", name: "Upgrade Core", kind: "core", priceAmt: 0.25, desc: "Star upgrade / gear +1 (max +15)" },
  gem_atk_1: { id: "gem_atk_1", name: "Attack Gem Lv1", kind: "gem", stat: "atk", bonus: 2, level: 1, priceAmt: 0.4, desc: "+2 ATK when socketed" },
  gem_atk_2: { id: "gem_atk_2", name: "Attack Gem Lv2", kind: "gem", stat: "atk", bonus: 5, level: 2, priceAmt: 1.2, desc: "+5 ATK when socketed" },
  gem_atk_3: { id: "gem_atk_3", name: "Attack Gem Lv3", kind: "gem", stat: "atk", bonus: 10, level: 3, priceAmt: 3.0, desc: "+10 ATK when socketed" },
  gem_hp_1: { id: "gem_hp_1", name: "HP Gem Lv1", kind: "gem", stat: "hp", bonus: 10, level: 1, priceAmt: 0.4, desc: "+10 HP when socketed" },
  gem_hp_2: { id: "gem_hp_2", name: "HP Gem Lv2", kind: "gem", stat: "hp", bonus: 22, level: 2, priceAmt: 1.2, desc: "+22 HP when socketed" },
  gem_hp_3: { id: "gem_hp_3", name: "HP Gem Lv3", kind: "gem", stat: "hp", bonus: 40, level: 3, priceAmt: 3.0, desc: "+40 HP when socketed" },
  gem_def_1: { id: "gem_def_1", name: "Defense Gem Lv1", kind: "gem", stat: "def", bonus: 2, level: 1, priceAmt: 0.4, desc: "+2 DEF when socketed" },
  gem_def_2: { id: "gem_def_2", name: "Defense Gem Lv2", kind: "gem", stat: "def", bonus: 5, level: 2, priceAmt: 1.2, desc: "+5 DEF when socketed" },
  gem_def_3: { id: "gem_def_3", name: "Defense Gem Lv3", kind: "gem", stat: "def", bonus: 9, level: 3, priceAmt: 2.5, desc: "+9 DEF when socketed" }
};

function getMaterial(id) {
  return AMT_MATERIALS[id] || null;
}

async function addMaterial(client, memberId, materialId, qty) {
  const q = client.query.bind(client);
  await q(
    `INSERT INTO member_materials (member_id, material_id, qty)
     VALUES ($1, $2, $3)
     ON CONFLICT (member_id, material_id)
     DO UPDATE SET qty = member_materials.qty + EXCLUDED.qty`,
    [memberId, materialId, qty]
  );
}

async function spendMaterial(client, memberId, materialId, qty) {
  const r = await client.query(
    `SELECT qty FROM member_materials WHERE member_id = $1 AND material_id = $2 FOR UPDATE`,
    [memberId, materialId]
  );
  const have = r.rows.length ? Number(r.rows[0].qty) : 0;
  if (have < qty) {
    const m = getMaterial(materialId);
    throw Object.assign(new Error("Need " + qty + "x " + ((m && m.name) || materialId) + " (have " + have + ")."), { status: 400 });
  }
  await client.query(
    `UPDATE member_materials SET qty = qty - $1 WHERE member_id = $2 AND material_id = $3`,
    [qty, memberId, materialId]
  );
}

function gemBonus(gemId) {
  const m = getMaterial(gemId);
  if (!m || m.kind !== "gem") return { atk: 0, def: 0, hp: 0, spd: 0 };
  const b = { atk: 0, def: 0, hp: 0, spd: 0 };
  b[m.stat] = Number(m.bonus) || 0;
  return b;
}


async function getPetEquipmentMap(client, ownedPetId) {
  const q = client ? client.query.bind(client) : pool.query.bind(pool);
  const r = await q(
    `SELECT slot, gear_id, COALESCE(upgrade_level,0) AS upgrade_level, gem1, gem2
     FROM pet_equipment WHERE owned_pet_id = $1`,
    [ownedPetId]
  );
  const map = {};
  for (const row of r.rows) {
    map[row.slot] = {
      gear_id: row.gear_id,
      upgrade_level: Number(row.upgrade_level) || 0,
      gem1: row.gem1 || null,
      gem2: row.gem2 || null
    };
  }
  return map;
}

function sumGearBonuses(equipMap) {
  const b = { atk: 0, def: 0, hp: 0, spd: 0, items: [] };
  for (const slot of Object.keys(equipMap || {})) {
    const entry = equipMap[slot];
    const gearId = typeof entry === "string" ? entry : entry.gear_id;
    const up = typeof entry === "object" ? (Number(entry.upgrade_level) || 0) : 0;
    const g = getGearById(gearId);
    if (!g) continue;
    // +12% base stats per upgrade level
    const mult = 1 + up * 0.12;
    let atk = Math.round((Number(g.atk) || 0) * mult);
    let def = Math.round((Number(g.def) || 0) * mult);
    let hp = Math.round((Number(g.hp) || 0) * mult);
    let spd = Math.round((Number(g.spd) || 0) * mult);
    if (typeof entry === "object") {
      for (const gid of [entry.gem1, entry.gem2]) {
        const gb = gemBonus(gid);
        atk += gb.atk; def += gb.def; hp += gb.hp; spd += gb.spd;
      }
    }
    b.atk += atk; b.def += def; b.hp += hp; b.spd += spd;
    b.items.push({
      slot, ...g, upgrade_level: up,
      gem1: typeof entry === "object" ? entry.gem1 : null,
      gem2: typeof entry === "object" ? entry.gem2 : null,
      effective: { atk, def, hp, spd }
    });
  }
  return b;
}

function getPetById(petId) {
  return AMT_PETS.find(p => p.id === petId) || null;
}


function makeCertificateId(origin) {
  const crypto = require("crypto");
  const prefix =
    origin === "pi_payment"
      ? "AMT-MINT"
      : origin === "shop"
        ? "AMT-OWN"
        : "AMT-PET";
  return prefix + "-" + crypto.randomBytes(5).toString("hex").toUpperCase();
}

async function ensurePetTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS owned_pets (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      pet_id TEXT NOT NULL,
      name TEXT NOT NULL,
      element TEXT NOT NULL,
      rarity TEXT NOT NULL,
      level INT NOT NULL DEFAULT 1,
      exp INT NOT NULL DEFAULT 0,
      hp INT NOT NULL,
      atk INT NOT NULL,
      def INT NOT NULL,
      spd INT NOT NULL,
      ability TEXT NOT NULL,
      image TEXT,
      energy INT NOT NULL DEFAULT 100,
      happiness INT NOT NULL DEFAULT 100,
      is_listed BOOLEAN NOT NULL DEFAULT FALSE,
      purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_owned_pets_member ON owned_pets(member_id);

    CREATE TABLE IF NOT EXISTS pet_eggs (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      parent1_id BIGINT,
      parent2_id BIGINT,
      element TEXT NOT NULL,
      rarity TEXT NOT NULL DEFAULT 'Common',
      status TEXT NOT NULL DEFAULT 'READY',
      hatch_at TIMESTAMPTZ,
      is_listed BOOLEAN NOT NULL DEFAULT FALSE,
      gen INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pet_listings (
      id BIGSERIAL PRIMARY KEY,
      seller_member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      owned_pet_id BIGINT REFERENCES owned_pets(id) ON DELETE CASCADE,
      egg_id BIGINT REFERENCES pet_eggs(id) ON DELETE CASCADE,
      listing_type TEXT NOT NULL DEFAULT 'PET',
      price_amt NUMERIC(20,8) NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS egg_listings (
      id BIGSERIAL PRIMARY KEY,
      seller_member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      egg_id BIGINT NOT NULL REFERENCES pet_eggs(id) ON DELETE CASCADE,
      price_amt NUMERIC(20,8) NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS market_escrows (
      id BIGSERIAL PRIMARY KEY,
      listing_id BIGINT,
      listing_kind TEXT NOT NULL DEFAULT 'PET',
      buyer_member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      seller_member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      asset_id BIGINT NOT NULL,
      price_amt NUMERIC(20,8) NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      hold_ref TEXT,
      release_ref TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS pet_battles (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      owned_pet_id BIGINT NOT NULL,
      opponent_name TEXT NOT NULL,
      result TEXT NOT NULL,
      reward_amt NUMERIC(20,8) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Ensure columns exist if table was created by older schema
  const alts = [
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS energy INT NOT NULL DEFAULT 100`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS hunger INT NOT NULL DEFAULT 100`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS thirst INT NOT NULL DEFAULT 100`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS pet_status TEXT NOT NULL DEFAULT 'ACTIVE'`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS last_needs_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS stars INT NOT NULL DEFAULT 1`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS happiness INT NOT NULL DEFAULT 100`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS is_listed BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS image TEXT`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS level INT NOT NULL DEFAULT 1`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS exp INT NOT NULL DEFAULT 0`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS session_type TEXT`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS session_ends_at TIMESTAMPTZ`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS session_stat TEXT`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS session_xp INT NOT NULL DEFAULT 0`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS session_cost NUMERIC(18,8) NOT NULL DEFAULT 0`,

    `ALTER TABLE pet_eggs ADD COLUMN IF NOT EXISTS is_listed BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE pet_eggs ADD COLUMN IF NOT EXISTS gen INT NOT NULL DEFAULT 1`,
    `ALTER TABLE pet_listings ADD COLUMN IF NOT EXISTS egg_id BIGINT`,
    `ALTER TABLE pet_listings ADD COLUMN IF NOT EXISTS listing_type TEXT DEFAULT 'PET'`,
    `ALTER TABLE pet_listings ALTER COLUMN owned_pet_id DROP NOT NULL`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS rep INT NOT NULL DEFAULT 0`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS wins INT NOT NULL DEFAULT 0`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS losses INT NOT NULL DEFAULT 0`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS origin TEXT DEFAULT 'shop'`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS certificate_id TEXT`
  ];
  for (const q of alts) {
    try {
      await pool.query(q);
    } catch (e) {
      /* ignore */
    }
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_ownership_history (
      id BIGSERIAL PRIMARY KEY,
      owned_pet_id BIGINT NOT NULL,
      from_member_id BIGINT,
      to_member_id BIGINT,
      event_type TEXT NOT NULL,
      price_amt NUMERIC(20,8) DEFAULT 0,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS owner_rep (
      member_id BIGINT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
      rep INT NOT NULL DEFAULT 0,
      wins INT NOT NULL DEFAULT 0,
      losses INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_story_progress (
      member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      chapter INT NOT NULL DEFAULT 1,
      clears_today INT NOT NULL DEFAULT 0,
      clear_date DATE,
      total_clears INT NOT NULL DEFAULT 0,
      PRIMARY KEY (member_id)
    )
  `);
}

function repBadge(rep) {
  const r = Number(rep) || 0;
  if (r >= 500) return "Mythic Ace";
  if (r >= 250) return "Legend";
  if (r >= 120) return "Veteran";
  if (r >= 40) return "Fighter";
  return "Rookie";
}

async function ensureOwnerRep(client, memberId) {
  const q = client ? client.query.bind(client) : pool.query.bind(pool);
  await q(
    `INSERT INTO owner_rep (member_id, rep, wins, losses)
     VALUES ($1, 0, 0, 0) ON CONFLICT (member_id) DO NOTHING`,
    [memberId]
  );
}

async function addOwnershipEvent(client, ownedPetId, fromId, toId, eventType, price, note) {
  const q = client ? client.query.bind(client) : pool.query.bind(pool);
  await q(
    `INSERT INTO pet_ownership_history
      (owned_pet_id, from_member_id, to_member_id, event_type, price_amt, note)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [ownedPetId, fromId || null, toId || null, eventType, price || 0, note || null]
  );
}

async function applyBattleRep(client, memberId, ownedPetId, won, tierKey, underdog) {
  let petRep = won ? 3 : 0;
  let ownerRep = won ? 2 : 0;
  if (won) {
    if (tierKey === "hunter") { petRep = 5; ownerRep = 3; }
    if (tierKey === "elite") { petRep = 8; ownerRep = 5; }
    if (tierKey === "mythic") { petRep = 12; ownerRep = 8; }
    if (tierKey === "pvp") { petRep = 6; ownerRep = 4; }
    if (tierKey === "squad") { petRep = 10; ownerRep = 6; }
    if (tierKey === "story") { petRep = 4; ownerRep = 2; }
    if (underdog) { petRep += 5; ownerRep += 3; }
  } else {
    petRep = 0;
    ownerRep = 0;
  }
  if (ownedPetId) {
    if (won) {
      await client.query(
        `UPDATE owned_pets SET rep = COALESCE(rep,0) + $1, wins = COALESCE(wins,0) + 1
         WHERE id = $2`,
        [petRep, ownedPetId]
      );
      try { await bumpMission(req.member.id, "battle", 1); } catch (_) {}
    } else {
      await client.query(
        `UPDATE owned_pets SET losses = COALESCE(losses,0) + 1 WHERE id = $1`,
        [ownedPetId]
      );
    }
  }
  await ensureOwnerRep(client, memberId);
  if (won) {
    await client.query(
      `UPDATE owner_rep SET rep = rep + $1, wins = wins + 1, updated_at = NOW()
       WHERE member_id = $2`,
      [ownerRep, memberId]
    );
  } else {
    await client.query(
      `UPDATE owner_rep SET losses = losses + 1, updated_at = NOW()
       WHERE member_id = $1`,
      [memberId]
    );
  }
  return { petRep, ownerRep };
}

const STORY_CHAPTERS = [
  { id: 1, name: "Whispering Forest", mult: 0.55, exp: 45, reward: 0.15, energy: 8 },
  { id: 2, name: "Crystal Cave", mult: 0.70, exp: 55, reward: 0.20, energy: 8 },
  { id: 3, name: "Storm Ridge", mult: 0.85, exp: 70, reward: 0.30, energy: 10 },
  { id: 4, name: "Ember Peak", mult: 1.00, exp: 85, reward: 0.40, energy: 10 },
  { id: 5, name: "Frozen Hollow", mult: 1.15, exp: 100, reward: 0.50, energy: 12 },
  { id: 6, name: "Thunder Valley", mult: 1.30, exp: 120, reward: 0.65, energy: 12 },
  { id: 7, name: "Shadow Marsh", mult: 1.45, exp: 140, reward: 0.80, energy: 14 },
  { id: 8, name: "Golden Ruins", mult: 1.60, exp: 160, reward: 1.00, energy: 14 },
  { id: 9, name: "Mythic Gate", mult: 1.80, exp: 200, reward: 1.40, energy: 16 },
  { id: 10, name: "Legend Trial", mult: 2.00, exp: 250, reward: 2.00, energy: 18 }
];

/* AFK grind map — leave pet on zone, claim later */
const GRIND_ZONES = [
  { id: 1, name: "Whispering Forest", minLevel: 1,  emoji: "🌲", expPerHour: 18, energyCostPerHour: 4, foodChance: 0.35, coreChance: 0.08, gemChance: 0.06, amtPerHour: 0.02 },
  { id: 2, name: "Crystal Cave",      minLevel: 5,  emoji: "💎", expPerHour: 28, energyCostPerHour: 5, foodChance: 0.40, coreChance: 0.10, gemChance: 0.08, amtPerHour: 0.03 },
  { id: 3, name: "Storm Ridge",       minLevel: 10, emoji: "⛈️", expPerHour: 40, energyCostPerHour: 6, foodChance: 0.42, coreChance: 0.12, gemChance: 0.10, amtPerHour: 0.04 },
  { id: 4, name: "Ember Peak",        minLevel: 15, emoji: "🌋", expPerHour: 55, energyCostPerHour: 7, foodChance: 0.45, coreChance: 0.14, gemChance: 0.12, amtPerHour: 0.05 },
  { id: 5, name: "Frozen Hollow",     minLevel: 20, emoji: "❄️", expPerHour: 72, energyCostPerHour: 8, foodChance: 0.48, coreChance: 0.16, gemChance: 0.14, amtPerHour: 0.06 },
  { id: 6, name: "Thunder Valley",    minLevel: 25, emoji: "⚡", expPerHour: 90, energyCostPerHour: 9, foodChance: 0.50, coreChance: 0.18, gemChance: 0.15, amtPerHour: 0.08 },
  { id: 7, name: "Shadow Marsh",      minLevel: 30, emoji: "🌫️", expPerHour: 110, energyCostPerHour: 10, foodChance: 0.52, coreChance: 0.20, gemChance: 0.16, amtPerHour: 0.10 },
  { id: 8, name: "Golden Ruins",      minLevel: 35, emoji: "🏛️", expPerHour: 135, energyCostPerHour: 11, foodChance: 0.55, coreChance: 0.22, gemChance: 0.18, amtPerHour: 0.12 }
];

const GRIND_DURATIONS = [
  { hours: 1,  label: "1h" },
  { hours: 4,  label: "4h" },
  { hours: 8,  label: "8h" },
  { hours: 24, label: "24h" }
];

async function ensureGrindTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_grinds (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      owned_pet_id BIGINT NOT NULL,
      zone_id INT NOT NULL,
      hours INT NOT NULL,
      energy_cost INT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ends_at TIMESTAMPTZ NOT NULL,
      claimed_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'active',
      reward_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pet_grinds_member ON pet_grinds(member_id, status);
    CREATE INDEX IF NOT EXISTS idx_pet_grinds_pet ON pet_grinds(owned_pet_id, status);
  `);
}
ensureGrindTables().catch(err => console.error("Grind tables:", err.message));

ensurePetTables().catch(err => console.error("Pet tables init:", err.message));

async function ensureDailyRewardTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_rewards (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      claim_date DATE NOT NULL,
      amount NUMERIC(20,8) NOT NULL,
      streak INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (member_id, claim_date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_rewards_member ON daily_rewards(member_id);
  `);
}
ensureDailyRewardTable().catch(err => console.error("Daily rewards table init:", err.message));

function utcDateString(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function yesterdayUtcString() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Normalize PG DATE / Date / string → YYYY-MM-DD (UTC) */
function asYmd(v) {
  if (v == null || v === "") return null;
  if (typeof v === "string") {
    // "2026-10-01" or ISO datetime
    const m = v.match(/(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    const d = new Date(v);
    if (!isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
    return v.slice(0, 10);
  }
  if (v instanceof Date && !isNaN(v.getTime())) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const day = String(v.getUTCDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }
  try {
    return asYmd(String(v));
  } catch (e) {
    return null;
  }
}

function dailyAmountForStreak(streak) {
  const s = Math.max(1, Math.min(DAILY_MAX_STREAK, Number(streak) || 1));
  return DAILY_REWARD_AMOUNTS[s - 1];
}

/** Count consecutive UTC days ending at endYmd from claim date list (YYYY-MM-DD desc or asc). */
function streakFromClaimDates(datesYmd, endYmd) {
  const set = new Set((datesYmd || []).map(asYmd).filter(Boolean));
  if (!endYmd || !set.has(endYmd)) return 0;
  let streak = 0;
  let cur = endYmd;
  while (set.has(cur) && streak < DAILY_MAX_STREAK) {
    streak += 1;
    const d = new Date(cur + "T00:00:00.000Z");
    d.setUTCDate(d.getUTCDate() - 1);
    cur = d.toISOString().slice(0, 10);
  }
  return streak;
}

/* ---------- Catalog ---------- */
app.get("/api/pets", async (req, res) => {
  try {
    const element = String(req.query.element || "").trim();
    let pets = AMT_PETS;
    if (element) {
      pets = AMT_PETS.filter(p => p.element.toLowerCase() === element.toLowerCase());
    }
    res.json({ ok: true, total: pets.length, elements: PET_ELEMENTS, rarities: PET_RARITIES, pets });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Unable to load pets." });
  }
});

/* ---------- My pets (MUST be before /api/pets/:petId) ---------- */

app.get("/api/pets/leaderboard", async (req, res) => {
  try {
    await ensurePetTables();
    const limit = Math.min(30, Math.max(5, Number(req.query.limit) || 15));
    const r = await pool.query(
      `SELECT op.id, op.name, op.level, op.stars, op.rarity, op.element,
              op.hp, op.atk, op.def, m.username
       FROM owned_pets op
       JOIN members m ON m.id = op.member_id
       WHERE COALESCE(op.pet_status, 'ACTIVE') <> 'RUNAWAY'
       ORDER BY COALESCE(op.level,1) DESC, COALESCE(op.stars,1) DESC, op.id ASC
       LIMIT $1`,
      [limit]
    );
    const rows = r.rows.map((row, i) => {
      const title = petTitle(row.level, row.stars, row.rarity);
      return {
        rank: i + 1,
        name: row.name,
        username: row.username,
        level: Number(row.level) || 1,
        stars: Number(row.stars != null ? row.stars : 1),
        rarity: row.rarity || rarityFromLevel(row.level),
        element: row.element,
        title: title || null
      };
    });
    res.json({ ok: true, leaderboard: rows });
  } catch (e) {
    console.error("LEADERBOARD:", e);
    res.status(500).json({ ok: false, error: e.message || "Leaderboard failed." });
  }
});

app.get("/api/pets/owned", requireAuth, async (req, res) => {
  try {
    await ensurePetTables();
    const result = await pool.query(
      `SELECT * FROM owned_pets WHERE member_id = $1
       ORDER BY COALESCE(level,1) DESC, COALESCE(stars,1) DESC, id DESC`,
      [req.member.id]
    );
    const pets = [];
    for (const row of result.rows) {
      try {
        pets.push(await applyNeedsDecay(pool, row));
      } catch (e) {
        pets.push(row);
      }
    }
    res.json({
      ok: true,
      count: pets.length,
      memberId: req.member.id,
      pets
    });
  } catch (e) {
    console.error("OWNED PETS ERROR:", e);
    res.status(500).json({
      ok: false,
      error: "Unable to load owned pets. " + (e.message || "")
    });
  }
});

/* ---------- Buy from market ---------- */

function petPricePi(pet) {
  if (!pet) return null;
  const r = String(pet.rarity || "Common").toLowerCase();
  const map = {
    common: 0.1,
    uncommon: 0.25,
    rare: 0.5,
    epic: 1.0,
    legendary: 2.0,
    mythic: 5.0
  };
  return map[r] != null ? map[r] : 0.1;
}

function parsePetProductId(productId) {
  const id = String(productId || "").trim();
  if (id.startsWith("pet:")) {
    return { kind: "pet", petId: id.slice(4) };
  }
  return { kind: "other", productId: id };
}


app.get("/api/pets/pi-price/:petId", requireAuth, async (req, res) => {
  const pet = getPetById(String(req.params.petId || "").trim());
  if (!pet) {
    return res.status(404).json({ ok: false, error: "Pet not found." });
  }
  res.json({
    ok: true,
    petId: pet.id,
    name: pet.name,
    rarity: pet.rarity,
    priceAmt: pet.priceAmt,
    pricePi: petPricePi(pet),
    productId: "pet:" + pet.id
  });
});

app.post("/api/pets/buy", requireAuth, async (req, res) => {
  const petId = String(req.body?.petId || "").trim();
  const pet = getPetById(petId);
  if (!pet) {
    return res.status(404).json({ ok: false, error: "Pet not found." });
  }

  const client = await pool.connect();
  try {
    await ensurePetTables();
    await client.query("BEGIN");
    await client.query(
      `SELECT id FROM members WHERE id = $1 FOR UPDATE`,
      [req.member.id]
    );

    const balance = await getBalance(req.member.id, client);
    if (balance < pet.priceAmt) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error:
          "Insufficient in-app AMT. Mine or claim airdrop first. Need " +
          pet.priceAmt +
          " AMT (you have " +
          balance +
          ").",
        balance,
        required: pet.priceAmt
      });
    }

    const reference = makeReference("AMT-PET");
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference)
       VALUES ($1,$2,'PET_PURCHASE',$3)`,
      [req.member.id, -pet.priceAmt, reference]
    );
    const ins = await client.query(
      `INSERT INTO owned_pets
        (member_id, pet_id, name, element, rarity, hp, atk, def, spd, ability, image, origin, certificate_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'shop',$12)
       RETURNING *`,
      [
        req.member.id,
        pet.id,
        pet.name,
        pet.element,
        pet.rarity,
        pet.hp,
        pet.atk,
        pet.def,
        pet.spd,
        pet.ability,
        pet.image,
        makeCertificateId("shop")
      ]
    );
    try {
      await addOwnershipEvent(client, ins.rows[0].id, null, req.member.id, "ORIGIN_SHOP", pet.priceAmt, "Bought from shop");
    } catch (e) { console.error("ownership shop:", e.message); }
    await client.query("COMMIT");

    // Verify row is actually readable after commit
    const verify = await pool.query(
      `SELECT * FROM owned_pets WHERE id = $1 AND member_id = $2`,
      [ins.rows[0].id, req.member.id]
    );
    if (!verify.rows.length) {
      console.error("PET BUY VERIFY FAIL member=", req.member.id, "pet=", ins.rows[0]?.id);
      return res.status(500).json({
        ok: false,
        error: "Pet buy committed but not readable. Contact admin."
      });
    }

    const newBalance = await getBalance(req.member.id);
    res.json({
      ok: true,
      purchased: true,
      pet: verify.rows[0],
      paid: pet.priceAmt,
      balance: newBalance,
      reference,
      memberId: req.member.id,
      message: pet.name + " saved to My Pets."
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (err) {}
    console.error("PET BUY ERROR:", e);
    res.status(500).json({
      ok: false,
      error: "Unable to buy pet. " + (e.message || "Server error")
    });
  } finally {
    client.release();
  }
});

/* ---------- Starter pet (one free Common per pioneer) ---------- */
app.get("/api/pets/starter-status", requireAuth, async (req, res) => {
  try {
    await ensurePetTables();
    const claimed = await pool.query(
      `SELECT id FROM amt_ledger
       WHERE member_id = $1 AND type = 'PET_STARTER'
       LIMIT 1`,
      [req.member.id]
    );
    const ownedCount = await pool.query(
      `SELECT COUNT(*)::INT AS c FROM owned_pets WHERE member_id = $1`,
      [req.member.id]
    );
    res.json({
      ok: true,
      claimed: claimed.rows.length > 0,
      ownedCount: Number(ownedCount.rows[0]?.c || 0),
      canClaim: claimed.rows.length === 0
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Status failed" });
  }
});

app.post("/api/pets/claim-starter", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensurePetTables();
    await client.query("BEGIN");
    await client.query(`SELECT id FROM members WHERE id = $1 FOR UPDATE`, [
      req.member.id
    ]);

    const claimed = await client.query(
      `SELECT id FROM amt_ledger
       WHERE member_id = $1 AND type = 'PET_STARTER'
       LIMIT 1`,
      [req.member.id]
    );
    if (claimed.rows.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "Starter pet already claimed."
      });
    }

    // Prefer Terra; fallback first Common
    let pet =
      getPetById("earth-terra") ||
      AMT_PETS.find(p => p.rarity === "Common") ||
      AMT_PETS[0];
    if (!pet) {
      await client.query("ROLLBACK");
      return res.status(500).json({ ok: false, error: "No starter pet available." });
    }

    const ref = `AMT-PET-STARTER-${req.member.id}`;
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference)
       VALUES ($1, 0, 'PET_STARTER', $2)`,
      [req.member.id, ref]
    );

    const ins = await client.query(
      `INSERT INTO owned_pets
        (member_id, pet_id, name, element, rarity, hp, atk, def, spd, ability, image, level, exp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,0)
       RETURNING *`,
      [
        req.member.id,
        pet.id,
        pet.name,
        pet.element,
        "Common",
        pet.hp,
        pet.atk,
        pet.def,
        pet.spd,
        pet.ability,
        pet.image
      ]
    );
        try {
      await addOwnershipEvent(client, ins.rows[0].id, null, req.member.id, "ORIGIN_STARTER", 0, "Starter claim");
    } catch (e) {}
await client.query("COMMIT");
    res.json({
      ok: true,
      pet: ins.rows[0],
      message: "Starter pet " + pet.name + " claimed — free once per pioneer."
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    if (e.code === "23505") {
      return res.status(409).json({
        ok: false,
        error: "Starter pet already claimed."
      });
    }
    console.error("STARTER PET:", e);
    res.status(500).json({
      ok: false,
      error: "Unable to claim starter. " + (e.message || "")
    });
  } finally {
    client.release();
  }
});

/* ---------- Energy pack shop (AMT sink) ---------- */
const ENERGY_PACKS = {
  energy: { cost: 1, energy: 100, happiness: 0, label: "Full Energy" },
  full: { cost: 3, energy: 100, happiness: 100, label: "Energy + Happiness" }
};

app.post("/api/pets/energy-pack", requireAuth, async (req, res) => {
  const ownedId = Number(req.body?.ownedPetId);
  const packId = String(req.body?.pack || "energy").toLowerCase();
  const pack = ENERGY_PACKS[packId];
  if (!pack) {
    return res.status(400).json({
      ok: false,
      error: "Invalid pack. Use energy (1 AMT) or full (3 AMT)."
    });
  }
  if (!Number.isFinite(ownedId) || ownedId < 1) {
    return res.status(400).json({ ok: false, error: "ownedPetId required." });
  }

  const client = await pool.connect();
  try {
    await ensurePetTables();
    await client.query("BEGIN");
    const pet = await client.query(
      `SELECT * FROM owned_pets WHERE id = $1 AND member_id = $2 FOR UPDATE`,
      [ownedId, req.member.id]
    );
    if (!pet.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found in My Pets." });
    }
    const balance = await getBalance(req.member.id, client);
    if (balance < pack.cost) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error:
          "Need " + pack.cost + " AMT (you have " + balance + ")."
      });
    }
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference)
       VALUES ($1,$2,'ENERGY_PACK',$3)`,
      [req.member.id, -pack.cost, makeReference("AMT-PACK")]
    );
    const final = await client.query(
      `UPDATE owned_pets SET
        energy = CASE WHEN $1 > 0 THEN 100 ELSE energy END,
        happiness = CASE WHEN $2 > 0 THEN 100 ELSE happiness END
       WHERE id = $3 RETURNING *`,
      [pack.energy, pack.happiness, ownedId]
    );
    await client.query("COMMIT");
    res.json({
      ok: true,
      pack: packId,
      cost: pack.cost,
      label: pack.label,
      pet: final.rows[0],
      message: pack.label + " applied (−" + pack.cost + " AMT)"
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("ENERGY PACK:", e);
    res.status(500).json({
      ok: false,
      error: "Pack failed. " + (e.message || "")
    });
  } finally {
    client.release();
  }
});

/* ---------- Care (feed / play) ---------- */

/* ---- Pet needs: hunger / thirst / runaway ----
   Decay ~3 hunger + 4 thirst per real hour offline.
   If both <= 5 after decay → RUNAWAY (recoverable).
------------------------------------------------ */
async function applyNeedsDecay(client, petRow) {
  if (!petRow) return petRow;
  if (String(petRow.pet_status || "ACTIVE") === "RUNAWAY") return petRow;
  const q = client.query.bind(client);
  const last = petRow.last_needs_at ? new Date(petRow.last_needs_at).getTime() : Date.now();
  const hours = Math.max(0, (Date.now() - last) / 3600000);
  if (hours < 0.15) return petRow; // < ~9 min skip
  let hunger = Number(petRow.hunger != null ? petRow.hunger : 100);
  let thirst = Number(petRow.thirst != null ? petRow.thirst : 100);
  const dh = Math.floor(hours * 3);
  const dt = Math.floor(hours * 4);
  hunger = Math.max(0, hunger - dh);
  thirst = Math.max(0, thirst - dt);
  let status = String(petRow.pet_status || "ACTIVE");
  // Run away if critically neglected
  if (hunger <= 5 && thirst <= 5 && hours >= 6) {
    status = "RUNAWAY";
  }
  await q(
    `UPDATE owned_pets SET hunger = $1, thirst = $2, pet_status = $3, last_needs_at = NOW()
     WHERE id = $4`,
    [hunger, thirst, status, petRow.id]
  );
  return { ...petRow, hunger, thirst, pet_status: status, last_needs_at: new Date().toISOString() };
}


/* ---- Care ALL pets (instant feed / water / play) ---- */
app.post("/api/pets/care-all", requireAuth, async (req, res) => {
  const action = String(req.body?.action || "feed").toLowerCase();
  if (!["feed", "water", "play", "both"].includes(action)) {
    return res.status(400).json({ ok: false, error: "action must be feed, water, play, or both." });
  }
  const client = await pool.connect();
  try {
    await ensurePetTables();
    await client.query("BEGIN");
    const petsR = await client.query(
      `SELECT * FROM owned_pets
       WHERE member_id = $1 AND COALESCE(pet_status, 'ACTIVE') <> 'RUNAWAY'
       ORDER BY
         LEAST(COALESCE(hunger,100), COALESCE(thirst,100)) ASC,
         COALESCE(level,1) DESC,
         id ASC
       LIMIT 200`,
      [req.member.id]
    );
    let pets = petsR.rows || [];
    if (!pets.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "No active pets. Rescue runaway pets first." });
    }
    // Apply decay then only charge pets that need care (or all for play)
    const updated = [];
    for (const p of pets) {
      updated.push(await applyNeedsDecay(client, p));
    }
    let targets = updated;
    if (action === "feed") {
      targets = updated.filter(p => Number(p.hunger != null ? p.hunger : 100) < 95);
    } else if (action === "water") {
      targets = updated.filter(p => Number(p.thirst != null ? p.thirst : 100) < 95);
    } else if (action === "both") {
      targets = updated.filter(p =>
        Number(p.hunger != null ? p.hunger : 100) < 95 ||
        Number(p.thirst != null ? p.thirst : 100) < 95
      );
    }
    if (!targets.length) {
      await client.query("COMMIT");
      return res.json({
        ok: true,
        cared: 0,
        cost: 0,
        message: "All pets already full 🍖💧 — nothing to pay."
      });
    }
    const unit =
      action === "play" ? 0.08 :
      action === "water" ? 0.12 :
      action === "both" ? 0.28 :
      0.15; // feed bulk discount vs 0.2 single
    const cost = Math.round(unit * targets.length * 100) / 100;
    const bal = await getBalance(req.member.id, client);
    if (bal < cost) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "Need " + cost + " AMT for " + targets.length + " pets (have " + bal + ")."
      });
    }
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'PET_CARE',$3)`,
      [req.member.id, -cost, makeReference("AMT-CAREALL")]
    );
    let cared = 0;
    for (const p of targets) {
      let hunger = Number(p.hunger != null ? p.hunger : 100);
      let thirst = Number(p.thirst != null ? p.thirst : 100);
      let energy = Number(p.energy != null ? p.energy : 100);
      let happy = Number(p.happiness != null ? p.happiness : 100);
      if (action === "feed" || action === "both") {
        hunger = 100;
        energy = Math.min(100, energy + 15);
      }
      if (action === "water" || action === "both") {
        thirst = 100;
      }
      if (action === "play") {
        happy = Math.min(100, happy + 20);
        energy = Math.min(100, energy + 8);
      }
      await client.query(
        `UPDATE owned_pets SET
          hunger = $1, thirst = $2, energy = $3, happiness = $4,
          last_needs_at = NOW(), pet_status = 'ACTIVE'
         WHERE id = $5 AND member_id = $6`,
        [hunger, thirst, energy, happy, p.id, req.member.id]
      );
      // small XP on bulk care
      try {
        await applyLevelAndRarity(client, p.id, req.member.id);
      } catch (_) {}
      cared++;
    }
    // grant a bit of exp via direct update for bulk (simpler)
    for (const p of targets) {
      await client.query(
        `UPDATE owned_pets SET exp = COALESCE(exp,0) + $1 WHERE id = $2`,
        [action === "play" ? 8 : 12, p.id]
      );
    }
    await client.query("COMMIT");
    if (cared > 0) {
      try { await bumpMission(req.member.id, "care", 1); } catch (_) {}
    }
    const label =
      action === "both" ? "Fed + Watered" :
      action === "water" ? "Watered" :
      action === "play" ? "Played with" : "Fed";
    res.json({
      ok: true,
      cared,
      totalPets: updated.length,
      cost,
      action,
      message: label + " " + cared + " pet(s) · −" + cost + " AMT"
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("CARE ALL:", e);
    res.status(500).json({ ok: false, error: e.message || "Care all failed." });
  } finally {
    client.release();
  }
});

app.post("/api/pets/care", requireAuth, async (req, res) => {
  const ownedId = Number(req.body?.ownedPetId);
  const action = String(req.body?.action || "feed").toLowerCase(); // feed | water | play
  const hours = Number(req.body?.durationHours || 0); // 0 instant | 4 | 12 | 24
  if (!Number.isFinite(ownedId) || ownedId < 1) {
    return res.status(400).json({ ok: false, error: "ownedPetId required." });
  }
  if (![0, 4, 12, 24].includes(hours)) {
    return res.status(400).json({ ok: false, error: "durationHours must be 0, 4, 12, or 24." });
  }
  if (!["feed", "water", "play"].includes(action)) {
    return res.status(400).json({ ok: false, error: "action must be feed, water, or play." });
  }

  const baseCost = action === "play" ? 0.1 : (action === "water" ? 0.15 : 0.2);
  const cost = hours === 0 ? baseCost : (hours === 4 ? 0.3 : hours === 12 ? 0.6 : 1.0);
  const xpGain = hours === 0
    ? (action === "play" ? 12 : 18)
    : (hours === 4 ? 45 : hours === 12 ? 90 : 160);

  const client = await pool.connect();
  try {
    await ensurePetTables();
    await client.query("BEGIN");
    const pet = await client.query(
      `SELECT * FROM owned_pets WHERE id = $1 AND member_id = $2 FOR UPDATE`,
      [ownedId, req.member.id]
    );
    if (!pet.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found in your My Pets." });
    }
    let petRow = await applyNeedsDecay(client, pet.rows[0]);
    if (String(petRow.pet_status || "") === "RUNAWAY" && hours > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "Pet ran away! Use Rescue (AMT) or instant Feed/Water first."
      });
    }
    if (petRow.session_ends_at && new Date(petRow.session_ends_at) > new Date()) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "Pet is busy with a timed session. Wait for the timer, tap CLAIM when ready, or Cancel Session."
      });
    }
    const balance = await getBalance(req.member.id, client);
    if (balance < cost) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "Insufficient in-app AMT. Need " + cost + " (you have " + balance + ")."
      });
    }
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'PET_CARE',$3)`,
      [req.member.id, -cost, makeReference("AMT-CARE")]
    );
    try { await bumpMission(req.member.id, "care", 1); } catch (_) {}
    const energyGain = action === "feed" ? 30 : (action === "water" ? 10 : 15);
    const happyGain = action === "play" ? 30 : (action === "water" ? 12 : 15);

    if (hours === 0) {
      const hungerGain = action === "feed" ? 40 : (action === "water" ? 10 : 15);
      const thirstGain = action === "water" ? 45 : (action === "feed" ? 10 : 12);
      await client.query(
        `UPDATE owned_pets SET
          energy = LEAST(100, COALESCE(energy, 0) + $1),
          happiness = LEAST(100, COALESCE(happiness, 0) + $2),
          hunger = LEAST(100, COALESCE(hunger, 50) + $3),
          thirst = LEAST(100, COALESCE(thirst, 50) + $4),
          pet_status = 'ACTIVE',
          last_needs_at = NOW(),
          exp = COALESCE(exp, 0) + $5,
          session_type = NULL, session_ends_at = NULL, session_xp = 0
         WHERE id = $6`,
        [energyGain, happyGain, hungerGain, thirstGain, xpGain, ownedId]
      );
      const petAfter = await applyLevelAndRarity(client, ownedId, req.member.id);
      await client.query("COMMIT");
      return res.json({
        ok: true, action, cost, durationHours: 0, xpGained: xpGain,
        pet: petAfter, level: petAfter && petAfter.level
      });
    }

    const ends = new Date(Date.now() + hours * 3600 * 1000);
    await client.query(
      `UPDATE owned_pets SET
        energy = LEAST(100, COALESCE(energy, 0) + $1),
        happiness = LEAST(100, COALESCE(happiness, 0) + $2),
        session_type = $3,
        session_ends_at = $4,
        session_stat = NULL,
        session_xp = $5,
        session_cost = $6
       WHERE id = $7`,
      [energyGain, happyGain, "care_" + action, ends.toISOString(), xpGain, cost, ownedId]
    );
    const updated = await client.query(`SELECT * FROM owned_pets WHERE id = $1`, [ownedId]);
    await client.query("COMMIT");
    res.json({
      ok: true, action, cost, durationHours: hours, xpPending: xpGain,
      sessionEndsAt: ends.toISOString(), pet: updated.rows[0],
      message: "Care started · claim XP after " + hours + "h"
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("CARE ERROR:", e);
    res.status(500).json({ ok: false, error: "Care failed. " + (e.message || "") });
  } finally {
    client.release();
  }
});

/* ---------- Training ---------- */
app.post("/api/pets/train", requireAuth, async (req, res) => {
  const ownedId = Number(req.body?.ownedPetId);
  const stat = String(req.body?.stat || "atk").toLowerCase();
  const hours = Number(req.body?.durationHours || 0); // 0 instant | 8 | 12 | 24
  if (!Number.isFinite(ownedId) || ownedId < 1) {
    return res.status(400).json({ ok: false, error: "ownedPetId required." });
  }
  if (!["hp", "atk", "def", "spd"].includes(stat)) {
    return res.status(400).json({ ok: false, error: "Invalid stat." });
  }
  if (![0, 8, 12, 24].includes(hours)) {
    return res.status(400).json({ ok: false, error: "durationHours must be 0, 8, 12, or 24." });
  }

  const cost = hours === 0 ? 0.1 : (hours === 8 ? 0.4 : hours === 12 ? 0.7 : 1.2);
  const xpGain = hours === 0 ? 28 : (hours === 8 ? 70 : hours === 12 ? 110 : 200);
  const client = await pool.connect();
  try {
    await ensurePetTables();
    await client.query("BEGIN");
    const pet = await client.query(
      `SELECT * FROM owned_pets WHERE id = $1 AND member_id = $2 FOR UPDATE`,
      [ownedId, req.member.id]
    );
    if (!pet.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found in your My Pets." });
    }
    if (pet.rows[0].session_ends_at && new Date(pet.rows[0].session_ends_at) > new Date()) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "Pet is busy with a timed session. Wait for the timer, tap CLAIM when ready, or Cancel Session."
      });
    }
    if (Number(pet.rows[0].energy || 0) < 20) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "Pet needs more energy. Feed first (CARE)."
      });
    }
    const balance = await getBalance(req.member.id, client);
    if (balance < cost) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "Insufficient in-app AMT. Need " + cost + " (you have " + balance + ")."
      });
    }
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'PET_TRAIN',$3)`,
      [req.member.id, -cost, makeReference("AMT-TRAIN")]
    );
    const gain = stat === "hp" ? 12 : (stat === "atk" ? 6 : 4);

    if (hours === 0) {
      const beforeStat = Number(pet.rows[0][stat]) || 0;
      await client.query(
        `UPDATE owned_pets SET
          ${stat} = COALESCE(${stat}, 0) + $1,
          energy = GREATEST(0, COALESCE(energy, 0) - 20),
          exp = COALESCE(exp, 0) + $2,
          session_type = NULL, session_ends_at = NULL, session_xp = 0
         WHERE id = $3`,
        [gain, xpGain, ownedId]
      );
      const petAfter = await applyLevelAndRarity(client, ownedId, req.member.id);
      await client.query("COMMIT");
      const afterStat = beforeStat + gain;
      return res.json({
        ok: true,
        trained: stat,
        gain,
        cost,
        durationHours: 0,
        xpGained: xpGain,
        beforeStat: beforeStat,
        afterStat: afterStat,
        pet: petAfter,
        level: petAfter && petAfter.level,
        milestones: (petAfter && petAfter._milestones) || [],
        message: stat.toUpperCase() + " " + beforeStat + "→" + afterStat + " · +" + xpGain + " XP · -" + cost + " AMT"
      });
    }

    const ends = new Date(Date.now() + hours * 3600 * 1000);
    await client.query(
      `UPDATE owned_pets SET
        energy = GREATEST(0, COALESCE(energy, 0) - 20),
        session_type = 'train',
        session_ends_at = $1,
        session_stat = $2,
        session_xp = $3,
        session_cost = $4
       WHERE id = $5`,
      [ends.toISOString(), stat, xpGain, cost, ownedId]
    );
    // store stat gain in session_stat as "atk:2" style already session_stat = stat; apply gain on claim
    const updated = await client.query(`SELECT * FROM owned_pets WHERE id = $1`, [ownedId]);
    await client.query("COMMIT");
    res.json({
      ok: true, trained: stat, cost, durationHours: hours, xpPending: xpGain,
      sessionEndsAt: ends.toISOString(), pet: updated.rows[0],
      message: "Training started · claim XP + stats after " + hours + "h"
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("TRAIN ERROR:", e);
    res.status(500).json({ ok: false, error: "Train failed. " + (e.message || "") });
  } finally {
    client.release();
  }
});

/* ---------- Breeding → Egg ---------- */
app.post("/api/pets/breed", requireAuth, async (req, res) => {
  const p1 = Number(req.body?.pet1Id);
  const p2 = Number(req.body?.pet2Id);
  if (!Number.isFinite(p1) || !Number.isFinite(p2) || p1 < 1 || p2 < 1 || p1 === p2) {
    return res.status(400).json({ ok: false, error: "Two different owned pet IDs required." });
  }
  const cost = 1.0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pets = await client.query(
      `SELECT * FROM owned_pets WHERE id IN ($1,$2) AND member_id = $3 FOR UPDATE`,
      [p1, p2, req.member.id]
    );
    if (pets.rows.length !== 2) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Both pets must be owned by you." });
    }
    const balance = await getBalance(req.member.id, client);
    if (balance < cost) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Insufficient AMT. Breeding costs 1 AMT." });
    }
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'PET_BREED',$3)`,
      [req.member.id, -cost, makeReference("AMT-BREED")]
    );
    const element = pets.rows[0].element === pets.rows[1].element
      ? pets.rows[0].element
      : pets.rows[Math.floor(Math.random()*2)].element;
    const avgLv =
      (Number(pets.rows[0].level || 1) + Number(pets.rows[1].level || 1)) / 2;
    const gen = Math.max(1, Math.min(10, Math.floor(avgLv / 5) + 1));
    const hatchAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    const egg = await client.query(
      `INSERT INTO pet_eggs (member_id, parent1_id, parent2_id, element, rarity, status, hatch_at, gen)
       VALUES ($1,$2,$3,$4,'Common','INCUBATING',$5,$6) RETURNING *`,
      [req.member.id, p1, p2, element, hatchAt, gen]
    );
    await client.query("COMMIT");
    res.json({ ok: true, egg: egg.rows[0], cost, message: "Egg is incubating. Hatch in 24 hours." });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("BREED ERROR:", e);
    res.status(500).json({ ok: false, error: "Breeding failed." });
  } finally {
    client.release();
  }
});

/* ---------- My eggs ---------- */
app.get("/api/pets/eggs", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM pet_eggs WHERE member_id = $1 ORDER BY created_at DESC`,
      [req.member.id]
    );
    res.json({ ok: true, eggs: result.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Unable to load eggs." });
  }
});

/* ---------- Hatch egg ---------- */
app.post("/api/pets/hatch", requireAuth, async (req, res) => {
  const eggId = Number(req.body?.eggId);
  if (!Number.isInteger(eggId)) return res.status(400).json({ ok: false, error: "eggId required." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const eggRes = await client.query(
      `SELECT * FROM pet_eggs WHERE id = $1 AND member_id = $2 FOR UPDATE`,
      [eggId, req.member.id]
    );
    if (!eggRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Egg not found." });
    }
    const egg = eggRes.rows[0];
    if (egg.status === "HATCHED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Already hatched." });
    }
    if (egg.is_listed) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "Egg is listed for sale. Cancel listing first."
      });
    }
    if (egg.hatch_at) {
      const readyAt = new Date(egg.hatch_at).getTime();
      // 60s grace for device/server clock skew
      if (readyAt - 60 * 1000 > Date.now()) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          error: "Still incubating.",
          hatchAt: egg.hatch_at
        });
      }
    }
    // Pick a random pet of same element (prefer Common for hatch)
    let poolPets = AMT_PETS.filter(
      p =>
        p.element === egg.element &&
        String(p.rarity || "Common") === "Common"
    );
    if (!poolPets.length) {
      poolPets = AMT_PETS.filter(p => p.element === egg.element);
    }
    if (!poolPets.length) poolPets = AMT_PETS.slice();
    const base = poolPets[Math.floor(Math.random() * poolPets.length)] || AMT_PETS[0];

    // Unique owned instance; keep catalog id for art lookup
    const ownedPetId = String(base.id || "unknown") + "-egg" + eggId;
    const hatchRarity = rarityFromLevel(1); // Option A: Lv1 = Common

    const ins = await client.query(
      `INSERT INTO owned_pets
        (member_id, pet_id, name, element, rarity, hp, atk, def, spd, ability, image, level, exp, energy, happiness)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,0,100,100)
       RETURNING *`,
      [
        req.member.id,
        ownedPetId,
        base.name,
        base.element,
        hatchRarity,
        Number(base.hp || 80) + 5,
        Number(base.atk || 10) + 1,
        Number(base.def || 10) + 1,
        Number(base.spd || 10) + 1,
        base.ability || "Hatchling",
        base.image || null
      ]
    );

        try {
      const newId = (typeof ins !== "undefined" && ins.rows && ins.rows[0]) ? ins.rows[0].id : null;
      if (newId) await addOwnershipEvent(client, newId, null, req.member.id, "ORIGIN_HATCH", 0, "Hatched from egg");
    } catch (e) {}
if (!ins.rows.length) {
      await client.query("ROLLBACK");
      return res.status(500).json({ ok: false, error: "Hatch insert failed." });
    }

    await client.query(
      `UPDATE pet_eggs SET status = 'HATCHED', is_listed = FALSE WHERE id = $1`,
      [eggId]
    );
    await client.query("COMMIT");

    // Re-read to confirm visible to owner
    const verify = await pool.query(
      `SELECT * FROM owned_pets WHERE id = $1 AND member_id = $2`,
      [ins.rows[0].id, req.member.id]
    );
    const pet = verify.rows[0] || ins.rows[0];

    res.json({
      ok: true,
      hatched: true,
      pet,
      eggId,
      message: "Delivered " + pet.name + " to My Pets!"
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("HATCH ERROR:", e);
    res.status(500).json({
      ok: false,
      error: "Hatch failed. " + (e.message || "")
    });
  } finally {
    client.release();
  }
});

/* ---------- Public Sell (list) ---------- */
app.post("/api/pets/list", requireAuth, async (req, res) => {
  const ownedId = Number(req.body?.ownedPetId);
  const price = Number(req.body?.priceAmt);
  if (!Number.isInteger(ownedId) || !(price > 0)) {
    return res.status(400).json({ ok: false, error: "ownedPetId and priceAmt required." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pet = await client.query(
      `SELECT * FROM owned_pets WHERE id = $1 AND member_id = $2 FOR UPDATE`,
      [ownedId, req.member.id]
    );
    if (!pet.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    if (pet.rows[0].is_listed) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Already listed." });
    }
    await client.query(`UPDATE owned_pets SET is_listed = TRUE WHERE id = $1`, [ownedId]);
    const listing = await client.query(
      `INSERT INTO pet_listings (seller_member_id, owned_pet_id, price_amt)
       VALUES ($1,$2,$3) RETURNING *`,
      [req.member.id, ownedId, price]
    );
    await client.query("COMMIT");
    res.json({ ok: true, listing: listing.rows[0] });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ ok: false, error: "List failed." });
  } finally {
    client.release();
  }
});



/* ---------- Update pet sell price ---------- */
app.post("/api/pets/update-listing-price", requireAuth, async (req, res) => {
  const ownedId = Number(req.body?.ownedPetId);
  const price = Number(req.body?.priceAmt);
  if (!Number.isFinite(ownedId) || ownedId < 1) {
    return res.status(400).json({ ok: false, error: "ownedPetId required." });
  }
  if (!(price > 0)) {
    return res.status(400).json({ ok: false, error: "Valid priceAmt required." });
  }
  const client = await pool.connect();
  try {
    await ensurePetTables();
    await client.query("BEGIN");
    const pet = await client.query(
      `SELECT id FROM owned_pets WHERE id = $1 AND member_id = $2`,
      [ownedId, req.member.id]
    );
    if (!pet.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    const upd = await client.query(
      `UPDATE pet_listings SET price_amt = $1
       WHERE owned_pet_id = $2 AND seller_member_id = $3 AND status = 'ACTIVE'
       RETURNING id, price_amt`,
      [price, ownedId, req.member.id]
    );
    if (!upd.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "No active sell listing. List first." });
    }
    await client.query("COMMIT");
    res.json({
      ok: true,
      priceAmt: Number(upd.rows[0].price_amt),
      message: "Price updated to " + price + " AMT"
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ ok: false, error: "Update price failed." });
  } finally {
    client.release();
  }
});

/* ---------- Cancel pet public sell ---------- */
app.post("/api/pets/cancel-listing", requireAuth, async (req, res) => {
  const ownedId = Number(req.body?.ownedPetId);
  if (!Number.isFinite(ownedId) || ownedId < 1) {
    return res.status(400).json({ ok: false, error: "ownedPetId required." });
  }
  const client = await pool.connect();
  try {
    await ensurePetTables();
    await client.query("BEGIN");
    const pet = await client.query(
      `SELECT * FROM owned_pets WHERE id = $1 AND member_id = $2 FOR UPDATE`,
      [ownedId, req.member.id]
    );
    if (!pet.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    const upd = await client.query(
      `UPDATE pet_listings SET status = 'CANCELLED'
       WHERE owned_pet_id = $1 AND seller_member_id = $2 AND status = 'ACTIVE'
       RETURNING id`,
      [ownedId, req.member.id]
    );
    await client.query(`UPDATE owned_pets SET is_listed = FALSE WHERE id = $1`, [ownedId]);
    await client.query("COMMIT");
    res.json({
      ok: true,
      cancelled: upd.rows.length,
      message: upd.rows.length ? "Sell cancelled. Pet back in My Pets." : "No active sell listing."
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ ok: false, error: "Cancel sell failed." });
  } finally {
    client.release();
  }
});

/* ---------- List egg for public sell ---------- */
app.post("/api/pets/list-egg", requireAuth, async (req, res) => {
  const eggId = Number(req.body?.eggId);
  const price = Number(req.body?.priceAmt);
  if (!Number.isInteger(eggId) || !(price > 0)) {
    return res.status(400).json({ ok: false, error: "eggId and priceAmt required." });
  }
  const client = await pool.connect();
  try {
    await ensurePetTables();
    await client.query("BEGIN");
    const egg = await client.query(
      `SELECT * FROM pet_eggs WHERE id = $1 AND member_id = $2 FOR UPDATE`,
      [eggId, req.member.id]
    );
    if (!egg.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Egg not found." });
    }
    const E = egg.rows[0];
    if (E.status === "HATCHED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Cannot sell a hatched egg." });
    }
    if (E.is_listed) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Egg already listed." });
    }
    await client.query(`UPDATE pet_eggs SET is_listed = TRUE WHERE id = $1`, [eggId]);
    const listing = await client.query(
      `INSERT INTO egg_listings (seller_member_id, egg_id, price_amt)
       VALUES ($1,$2,$3) RETURNING *`,
      [req.member.id, eggId, price]
    );
    await client.query("COMMIT");
    res.json({ ok: true, listing: listing.rows[0], message: "Egg listed for " + price + " AMT" });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("LIST EGG:", e);
    res.status(500).json({ ok: false, error: "List egg failed. " + (e.message || "") });
  } finally {
    client.release();
  }
});

/* ---------- Cancel egg listing ---------- */
app.post("/api/pets/cancel-egg-listing", requireAuth, async (req, res) => {
  const eggId = Number(req.body?.eggId);
  if (!Number.isInteger(eggId)) {
    return res.status(400).json({ ok: false, error: "eggId required." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const egg = await client.query(
      `SELECT * FROM pet_eggs WHERE id = $1 AND member_id = $2 FOR UPDATE`,
      [eggId, req.member.id]
    );
    if (!egg.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Egg not found." });
    }
    await client.query(
      `UPDATE egg_listings SET status = 'CANCELLED'
       WHERE egg_id = $1 AND seller_member_id = $2 AND status = 'ACTIVE'`,
      [eggId, req.member.id]
    );
    await client.query(`UPDATE pet_eggs SET is_listed = FALSE WHERE id = $1`, [eggId]);
    await client.query("COMMIT");
    res.json({ ok: true, cancelled: true });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    res.status(500).json({ ok: false, error: "Cancel failed." });
  } finally {
    client.release();
  }
});

/* ---------- Buy egg from public sell ---------- */
app.post("/api/pets/buy-egg-listing", requireAuth, async (req, res) => {
  const listingId = Number(req.body?.listingId);
  if (!Number.isInteger(listingId)) {
    return res.status(400).json({ ok: false, error: "listingId required." });
  }
  const client = await pool.connect();
  try {
    await ensurePetTables();
    await client.query("BEGIN");
    const listing = await client.query(
      `SELECT * FROM egg_listings WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE`,
      [listingId]
    );
    if (!listing.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Egg listing not found." });
    }
    const L = listing.rows[0];
    if (Number(L.seller_member_id) === Number(req.member.id)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Cannot buy your own egg." });
    }
    const price = Number(L.price_amt);
    if (!Number.isFinite(price) || price <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Invalid price." });
    }
    const balance = await getBalance(req.member.id, client);
    if (balance < price) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Insufficient AMT." });
    }
    const egg = await client.query(
      `SELECT * FROM pet_eggs WHERE id = $1 FOR UPDATE`,
      [L.egg_id]
    );
    if (!egg.rows.length || egg.rows[0].status === "HATCHED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Egg no longer available." });
    }
    if (Number(egg.rows[0].member_id) !== Number(L.seller_member_id)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Egg ownership mismatch." });
    }

    const holdRef = "ESCROW-EGG-HOLD-" + listingId + "-" + req.member.id + "-" + Date.now();
    const releaseRef = "ESCROW-EGG-REL-" + listingId + "-" + L.seller_member_id + "-" + Date.now();
    const esc = await client.query(
      `INSERT INTO market_escrows
        (listing_id, listing_kind, buyer_member_id, seller_member_id, asset_id, price_amt, status, hold_ref, release_ref)
       VALUES ($1,'EGG',$2,$3,$4,$5,'PENDING',$6,$7)
       RETURNING id`,
      [listingId, req.member.id, L.seller_member_id, L.egg_id, price, holdRef, releaseRef]
    );
    const escrowId = esc.rows[0].id;

    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'ESCROW_HOLD',$3)`,
      [req.member.id, -price, holdRef]
    );
    await client.query(
      `UPDATE pet_eggs SET member_id = $1, is_listed = FALSE WHERE id = $2`,
      [req.member.id, L.egg_id]
    );
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'ESCROW_RELEASE',$3)`,
      [L.seller_member_id, price, releaseRef]
    );
    await client.query(
      `UPDATE egg_listings SET status = 'SOLD' WHERE id = $1`,
      [listingId]
    );
    await client.query(
      `UPDATE market_escrows SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1`,
      [escrowId]
    );
    await client.query("COMMIT");
    res.json({
      ok: true,
      purchased: true,
      escrow: true,
      escrowId,
      price,
      eggId: L.egg_id,
      message: "Escrow complete · Egg in Baby Room · Seller paid " + price + " AMT"
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("BUY EGG:", e);
    res.status(500).json({ ok: false, error: "Escrow egg buy failed. " + (e.message || "") });
  } finally {
    client.release();
  }
});

/* ---------- Public listings (pets + eggs) ---------- */
app.get("/api/pets/listings", async (req, res) => {
  try {
    await ensurePetTables();
    const pets = await pool.query(`
      SELECT l.id, l.price_amt, l.created_at, l.status,
             'PET' AS listing_type,
             p.name, p.element, p.rarity, p.hp, p.atk, p.def, p.spd, p.ability, p.image, p.level,
             p.origin, p.rep, p.wins, p.losses, p.certificate_id, p.stars,
             m.username AS seller_username,
             NULL::BIGINT AS egg_id,
             NULL::TIMESTAMPTZ AS hatch_at,
             NULL::TEXT AS egg_status,
             NULL::INT AS gen
      FROM pet_listings l
      JOIN owned_pets p ON p.id = l.owned_pet_id
      JOIN members m ON m.id = l.seller_member_id
      WHERE l.status = 'ACTIVE'
      ORDER BY l.created_at DESC
      LIMIT 80
    `);
    let eggs = { rows: [] };
    try {
      eggs = await pool.query(`
        SELECT l.id, l.price_amt, l.created_at, l.status,
               'EGG' AS listing_type,
               (e.element || ' Egg') AS name,
               e.element, e.rarity,
               NULL::INT AS hp, NULL::INT AS atk, NULL::INT AS def, NULL::INT AS spd,
               NULL::TEXT AS ability, NULL::TEXT AS image, 1 AS level,
               m.username AS seller_username,
               e.id AS egg_id, e.hatch_at, e.status AS egg_status, e.gen
        FROM egg_listings l
        JOIN pet_eggs e ON e.id = l.egg_id
        JOIN members m ON m.id = l.seller_member_id
        WHERE l.status = 'ACTIVE' AND e.status <> 'HATCHED'
        ORDER BY l.created_at DESC
        LIMIT 80
      `);
    } catch (err) {
      console.error("EGG LISTINGS QUERY:", err.message);
    }
    const listings = [...pets.rows, ...eggs.rows].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    );
    res.json({ ok: true, listings });
  } catch (e) {
    console.error("LISTINGS:", e);
    res.status(500).json({ ok: false, error: "Unable to load listings." });
  }
});

/* ---------- Buy from public sell (AMT ESCROW protected) ----------
   Flow in one atomic tx:
   1) Lock listing
   2) Hold buyer AMT (ESCROW_HOLD)
   3) Transfer pet → buyer
   4) Release AMT → seller (ESCROW_RELEASE / PET_SALE)
   5) Mark listing SOLD + escrow COMPLETED
   If any step fails → full rollback (buyer keeps AMT, pet stays with seller).
-------------------------------------------------------------- */

/* ---- P2P Pet Trade with escrow ---- */
async function ensurePetTradeTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_trades (
      id BIGSERIAL PRIMARY KEY,
      seller_member_id BIGINT NOT NULL REFERENCES members(id),
      buyer_member_id BIGINT REFERENCES members(id),
      owned_pet_id BIGINT NOT NULL,
      price_amt NUMERIC(18,8) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'OPEN',
      hold_ref TEXT,
      release_ref TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pet_trades_seller ON pet_trades(seller_member_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pet_trades_buyer ON pet_trades(buyer_member_id)`);
}

app.post("/api/pets/trade/create", requireAuth, async (req, res) => {
  const ownedPetId = Number(req.body?.ownedPetId);
  const toUsername = String(req.body?.toUsername || "").trim().toLowerCase();
  const priceAmt = Number(req.body?.priceAmt);
  if (!Number.isFinite(ownedPetId) || ownedPetId < 1) {
    return res.status(400).json({ ok: false, error: "ownedPetId required." });
  }
  if (!toUsername) {
    return res.status(400).json({ ok: false, error: "Buyer Pi username required." });
  }
  if (!(priceAmt > 0)) {
    return res.status(400).json({ ok: false, error: "priceAmt must be > 0." });
  }
  const client = await pool.connect();
  try {
    await ensurePetTradeTables();
    await ensurePetTables();
    await client.query("BEGIN");
    const buyerQ = await client.query(
      `SELECT id, username FROM members WHERE LOWER(username) = $1 LIMIT 1`,
      [toUsername]
    );
    if (!buyerQ.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Buyer not found. They must log in to AMT once." });
    }
    const buyerId = buyerQ.rows[0].id;
    if (Number(buyerId) === Number(req.member.id)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Cannot trade with yourself." });
    }
    const petQ = await client.query(
      `SELECT * FROM owned_pets WHERE id = $1 AND member_id = $2 FOR UPDATE`,
      [ownedPetId, req.member.id]
    );
    if (!petQ.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    const pet = petQ.rows[0];
    if (String(pet.is_listed) === "true" || pet.is_listed === true) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Unlist from Public Sell first." });
    }
    const open = await client.query(
      `SELECT id FROM pet_trades WHERE owned_pet_id = $1 AND status = 'OPEN' LIMIT 1`,
      [ownedPetId]
    );
    if (open.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Pet already has an open trade." });
    }
    const ins = await client.query(
      `INSERT INTO pet_trades (seller_member_id, buyer_member_id, owned_pet_id, price_amt, status)
       VALUES ($1,$2,$3,$4,'OPEN') RETURNING id`,
      [req.member.id, buyerId, ownedPetId, priceAmt]
    );
    await client.query("COMMIT");
    res.json({
      ok: true,
      tradeId: ins.rows[0].id,
      message: "Trade offer sent to @" + buyerQ.rows[0].username + " for " + priceAmt + " AMT"
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("TRADE CREATE:", e);
    res.status(500).json({ ok: false, error: e.message || "Trade create failed." });
  } finally {
    client.release();
  }
});

app.get("/api/pets/trade/list", requireAuth, async (req, res) => {
  try {
    await ensurePetTradeTables();
    const r = await pool.query(
      `SELECT t.*, op.name AS pet_name, op.level AS pet_level, op.rarity AS pet_rarity,
              op.element AS pet_element, op.stars AS pet_stars, op.image AS pet_image,
              s.username AS seller_username, b.username AS buyer_username
       FROM pet_trades t
       JOIN owned_pets op ON op.id = t.owned_pet_id
       JOIN members s ON s.id = t.seller_member_id
       LEFT JOIN members b ON b.id = t.buyer_member_id
       WHERE (t.seller_member_id = $1 OR t.buyer_member_id = $1)
       ORDER BY t.created_at DESC
       LIMIT 40`,
      [req.member.id]
    );
    res.json({ ok: true, trades: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Trade list failed." });
  }
});

app.post("/api/pets/trade/accept", requireAuth, async (req, res) => {
  const tradeId = Number(req.body?.tradeId);
  if (!Number.isFinite(tradeId) || tradeId < 1) {
    return res.status(400).json({ ok: false, error: "tradeId required." });
  }
  const client = await pool.connect();
  try {
    await ensurePetTradeTables();
    await ensurePetTables();
    await client.query("BEGIN");
    const tq = await client.query(
      `SELECT * FROM pet_trades WHERE id = $1 FOR UPDATE`,
      [tradeId]
    );
    if (!tq.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Trade not found." });
    }
    const tr = tq.rows[0];
    if (String(tr.status) !== "OPEN") {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Trade is not open." });
    }
    if (Number(tr.buyer_member_id) !== Number(req.member.id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ ok: false, error: "Only the invited buyer can accept." });
    }
    const petQ = await client.query(
      `SELECT * FROM owned_pets WHERE id = $1 AND member_id = $2 FOR UPDATE`,
      [tr.owned_pet_id, tr.seller_member_id]
    );
    if (!petQ.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Seller no longer owns this pet." });
    }
    const price = Number(tr.price_amt);
    const bal = await getBalance(req.member.id, client);
    if (bal < price) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Need " + price + " AMT (have " + bal + ")." });
    }
    const holdRef = makeReference("AMT-TRADE-HOLD");
    const releaseRef = makeReference("AMT-TRADE-REL");
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'ESCROW_HOLD',$3)`,
      [req.member.id, -price, holdRef]
    );
    await client.query(
      `UPDATE owned_pets SET member_id = $1, is_listed = false WHERE id = $2`,
      [req.member.id, tr.owned_pet_id]
    );
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'ESCROW_RELEASE',$3)`,
      [tr.seller_member_id, price, releaseRef]
    );
    await client.query(
      `UPDATE pet_trades SET status = 'COMPLETED', hold_ref = $1, release_ref = $2, completed_at = NOW() WHERE id = $3`,
      [holdRef, releaseRef, tradeId]
    );
    try {
      await client.query(
        `INSERT INTO pet_ownership_history (owned_pet_id, from_member_id, to_member_id, reason, reference)
         VALUES ($1,$2,$3,'P2P_TRADE',$4)`,
        [tr.owned_pet_id, tr.seller_member_id, req.member.id, releaseRef]
      );
    } catch (_) {}
    await client.query("COMMIT");
    res.json({
      ok: true,
      message: "Trade complete · paid " + price + " AMT · pet transferred (escrow)",
      tradeId,
      priceAmt: price
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("TRADE ACCEPT:", e);
    res.status(500).json({ ok: false, error: e.message || "Trade accept failed." });
  } finally {
    client.release();
  }
});

app.post("/api/pets/trade/cancel", requireAuth, async (req, res) => {
  const tradeId = Number(req.body?.tradeId);
  if (!Number.isFinite(tradeId) || tradeId < 1) {
    return res.status(400).json({ ok: false, error: "tradeId required." });
  }
  try {
    await ensurePetTradeTables();
    const r = await pool.query(
      `UPDATE pet_trades SET status = 'CANCELLED'
       WHERE id = $1 AND status = 'OPEN'
         AND (seller_member_id = $2 OR buyer_member_id = $2)
       RETURNING id`,
      [tradeId, req.member.id]
    );
    if (!r.rows.length) {
      return res.status(400).json({ ok: false, error: "Cannot cancel (not open or not yours)." });
    }
    res.json({ ok: true, message: "Trade cancelled." });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Cancel failed." });
  }
});

app.post("/api/pets/buy-listing", requireAuth, async (req, res) => {
  const listingId = Number(req.body?.listingId);
  if (!Number.isInteger(listingId)) return res.status(400).json({ ok: false, error: "listingId required." });

  const client = await pool.connect();
  try {
    await ensurePetTables();
    await client.query("BEGIN");
    const listing = await client.query(
      `SELECT * FROM pet_listings WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE`,
      [listingId]
    );
    if (!listing.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Listing not found." });
    }
    const L = listing.rows[0];
    if (Number(L.seller_member_id) === Number(req.member.id)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Cannot buy your own listing." });
    }
    const petLock = await client.query(
      `SELECT id, member_id, is_listed FROM owned_pets WHERE id = $1 FOR UPDATE`,
      [L.owned_pet_id]
    );
    if (!petLock.rows.length || Number(petLock.rows[0].member_id) !== Number(L.seller_member_id)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Pet no longer available from seller." });
    }
    const price = Number(L.price_amt);
    if (!Number.isFinite(price) || price <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Invalid listing price." });
    }
    const balance = await getBalance(req.member.id, client);
    if (balance < price) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Insufficient AMT." });
    }

    const holdRef = "ESCROW-PET-HOLD-" + listingId + "-" + req.member.id + "-" + Date.now();
    const releaseRef = "ESCROW-PET-REL-" + listingId + "-" + L.seller_member_id + "-" + Date.now();

    // Create escrow record (PENDING → COMPLETED in same tx)
    const esc = await client.query(
      `INSERT INTO market_escrows
        (listing_id, listing_kind, buyer_member_id, seller_member_id, asset_id, price_amt, status, hold_ref, release_ref)
       VALUES ($1,'PET',$2,$3,$4,$5,'PENDING',$6,$7)
       RETURNING id`,
      [listingId, req.member.id, L.seller_member_id, L.owned_pet_id, price, holdRef, releaseRef]
    );
    const escrowId = esc.rows[0].id;

    // 1) Hold buyer funds
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'ESCROW_HOLD',$3)`,
      [req.member.id, -price, holdRef]
    );

    // 2) Transfer pet under escrow
    await client.query(
      `UPDATE owned_pets SET member_id = $1, is_listed = FALSE WHERE id = $2`,
      [req.member.id, L.owned_pet_id]
    );
    try {
      await addOwnershipEvent(
        client,
        L.owned_pet_id,
        L.seller_member_id,
        req.member.id,
        "SALE",
        price,
        "Escrow marketplace sale #" + escrowId
      );
    } catch (e) { console.error("ownership sale:", e.message); }

    // 3) Release funds to seller
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'ESCROW_RELEASE',$3)`,
      [L.seller_member_id, price, releaseRef]
    );
    // Seller credit is ESCROW_RELEASE (shows in history). No double credit.

    await client.query(
      `UPDATE pet_listings SET status = 'SOLD' WHERE id = $1`,
      [listingId]
    );
    await client.query(
      `UPDATE market_escrows SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1`,
      [escrowId]
    );

    await client.query("COMMIT");
    res.json({
      ok: true,
      purchased: true,
      escrow: true,
      escrowId,
      price,
      message: "Escrow complete · Pet transferred · Seller paid " + price + " AMT"
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("BUY LISTING ERROR:", e);
    res.status(500).json({ ok: false, error: "Escrow purchase failed. " + (e.message || "") });
  } finally {
    client.release();
  }
});

/* ---------- Battle (simple PvE) ---------- */

/* =========================================================
   PET BATTLE — Tiered CPU + Async PvP
========================================================= */

const BATTLE_TIERS = {
  rookie:  { mult: 0.95, rewardMin: 0.15, rewardMax: 0.35, energy: 12, label: "Rookie" },
  hunter:  { mult: 1.20, rewardMin: 0.45, rewardMax: 0.90, energy: 15, label: "Hunter" },
  elite:   { mult: 1.55, rewardMin: 1.00, rewardMax: 2.20, energy: 20, label: "Elite" },
  mythic:  { mult: 2.00, rewardMin: 3.00, rewardMax: 7.00, energy: 25, label: "Mythic" }
};

const ELEMENT_BEATS = {
  Fire: "Nature",
  Nature: "Water",
  Water: "Fire",
  Thunder: "Water",
  Earth: "Thunder",
  Ice: "Nature",
  Wind: "Earth",
  Shadow: "Light",
  Light: "Shadow",
  Cosmic: "Shadow"
};

function elementMult(atkEl, defEl) {
  if (!atkEl || !defEl) return 1;
  const a = String(atkEl);
  const d = String(defEl);
  if (ELEMENT_BEATS[a] === d) return 1.35;
  if (ELEMENT_BEATS[d] === a) return 0.72;
  return 1;
}

function elementRelation(atkEl, defEl) {
  const m = elementMult(atkEl, defEl);
  if (m > 1) return { key: "advantage", label: "SUPER EFFECTIVE", mult: m };
  if (m < 1) return { key: "disadvantage", label: "RESISTED", mult: m };
  return { key: "neutral", label: "Neutral", mult: 1 };
}

function pickTier(bodyTier, petLevel) {
  const t = String(bodyTier || "").toLowerCase();
  if (BATTLE_TIERS[t]) return t;
  const lv = Number(petLevel) || 1;
  if (lv >= 30) return "elite";
  if (lv >= 15) return "hunter";
  if (lv >= 5) return "hunter";
  return "rookie";
}

async function ensureArenaTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_arena (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT NOT NULL REFERENCES members(id),
      owned_pet_id BIGINT NOT NULL,
      pet_name TEXT,
      pet_element TEXT,
      pet_image TEXT,
      level INT DEFAULT 1,
      hp INT DEFAULT 50,
      atk INT DEFAULT 10,
      def INT DEFAULT 10,
      spd INT DEFAULT 10,
      rating INT DEFAULT 1000,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_pvp_battles (
      id BIGSERIAL PRIMARY KEY,
      attacker_id BIGINT NOT NULL,
      defender_id BIGINT NOT NULL,
      attacker_pet_id BIGINT,
      defender_arena_id BIGINT,
      result TEXT,
      reward_amt NUMERIC(18,8) DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_battle_daily (
      member_id BIGINT NOT NULL,
      battle_date DATE NOT NULL,
      cpu_count INT DEFAULT 0,
      pvp_count INT DEFAULT 0,
      charges INT DEFAULT 5,
      wins INT DEFAULT 0,
      streak INT DEFAULT 0,
      bonus_earned INT DEFAULT 0,
      PRIMARY KEY (member_id, battle_date)
    )
  `);
  await pool.query(`ALTER TABLE pet_battle_daily ADD COLUMN IF NOT EXISTS charges INT DEFAULT 5`);
  await pool.query(`ALTER TABLE pet_battle_daily ADD COLUMN IF NOT EXISTS wins INT DEFAULT 0`);
  await pool.query(`ALTER TABLE pet_battle_daily ADD COLUMN IF NOT EXISTS streak INT DEFAULT 0`);
  await pool.query(`ALTER TABLE pet_battle_daily ADD COLUMN IF NOT EXISTS bonus_earned INT DEFAULT 0`);
}

/* Community request: unlimited PvE battles (no daily charge cap). */
const BATTLE_UNLIMITED = true;
const BATTLE_BASE_CHARGES = BATTLE_UNLIMITED ? 9999 : 5;
const BATTLE_MAX_CHARGES = BATTLE_UNLIMITED ? 9999 : 15;
const BATTLE_MAX_BONUS = BATTLE_UNLIMITED ? 0 : 10;

async function getBattleDay(client, memberId) {
  const day = new Date().toISOString().slice(0, 10);
  const q = client ? client.query.bind(client) : pool.query.bind(pool);
  await q(
    `INSERT INTO pet_battle_daily
      (member_id, battle_date, cpu_count, pvp_count, charges, wins, streak, bonus_earned)
     VALUES ($1, $2::date, 0, 0, $3, 0, 0, 0)
     ON CONFLICT (member_id, battle_date) DO NOTHING`,
    [memberId, day, BATTLE_BASE_CHARGES]
  );
  const r = await q(
    `SELECT * FROM pet_battle_daily WHERE member_id = $1 AND battle_date = $2::date`,
    [memberId, day]
  );
  let row = r.rows[0];
  if (BATTLE_UNLIMITED && row && Number(row.charges) < 9999) {
    await q(
      `UPDATE pet_battle_daily SET charges = 9999
       WHERE member_id = $1 AND battle_date = $2::date`,
      [memberId, day]
    );
    row = { ...row, charges: 9999 };
  }
  return { day, row };
}

/** Spend 1 charge; return error string or null */
async function spendBattleCharge(client, memberId) {
  const { day, row } = await getBattleDay(client, memberId);
  if (BATTLE_UNLIMITED) {
    await client.query(
      `UPDATE pet_battle_daily SET cpu_count = cpu_count + 1
       WHERE member_id = $1 AND battle_date = $2::date`,
      [memberId, day]
    );
    return { error: null, charges: 9999, day, unlimited: true };
  }
  let charges = Number(row.charges);
  if (Number.isNaN(charges) || row.charges == null) charges = BATTLE_BASE_CHARGES;
  if (charges <= 0) {
    return {
      error:
        "No battle charges left. Win battles to earn more (max " +
        BATTLE_MAX_CHARGES +
        "/day). Resets tomorrow.",
      charges: 0,
      day
    };
  }
  await client.query(
    `UPDATE pet_battle_daily SET charges = charges - 1, cpu_count = cpu_count + 1
     WHERE member_id = $1 AND battle_date = $2::date`,
    [memberId, day]
  );
  return { error: null, charges: charges - 1, day };
}

/** After a battle: win grants +1 charge (capped), streak bonus */
async function applyBattleWinCharges(client, memberId, day, won) {
  const r = await client.query(
    `SELECT charges, wins, streak, bonus_earned FROM pet_battle_daily
     WHERE member_id = $1 AND battle_date = $2::date`,
    [memberId, day]
  );
  if (!r.rows.length) return { charges: 0, streak: 0, bonus: 0 };
  let { charges, wins, streak, bonus_earned } = r.rows[0];
  charges = Number(charges) || 0;
  wins = Number(wins) || 0;
  streak = Number(streak) || 0;
  bonus_earned = Number(bonus_earned) || 0;
  let bonus = 0;
  let msg = [];

  if (won) {
    wins += 1;
    streak += 1;
    if (bonus_earned < BATTLE_MAX_BONUS && charges < BATTLE_MAX_CHARGES) {
      charges = Math.min(BATTLE_MAX_CHARGES, charges + 1);
      bonus_earned += 1;
      bonus += 1;
      msg.push("+1 charge for win");
    }
    if (streak > 0 && streak % 3 === 0 && bonus_earned < BATTLE_MAX_BONUS && charges < BATTLE_MAX_CHARGES) {
      charges = Math.min(BATTLE_MAX_CHARGES, charges + 1);
      bonus_earned += 1;
      bonus += 1;
      msg.push("3-win streak +1 charge");
    }
  } else {
    streak = 0;
  }

  await client.query(
    `UPDATE pet_battle_daily
     SET charges = $1, wins = $2, streak = $3, bonus_earned = $4
     WHERE member_id = $5 AND battle_date = $6::date`,
    [charges, wins, streak, bonus_earned, memberId, day]
  );
  return { charges, wins, streak, bonus, bonus_earned, message: msg.join(" · ") };
}


function simulateBattle(my, en, myEl, enEl) {
  // Skills-enabled duel (1v1 CPU / PvP)
  const a = { ...my, level: my.level || 1, maxHp: my.maxHp || my.hp };
  const b = { ...en, level: en.level || 1, maxHp: en.maxHp || en.hp };
  if (typeof simulateBattleWithSkills === "function") {
    return simulateBattleWithSkills(a, b, myEl, enEl);
  }
  let myHp = my.hp, enHp = en.hp;
  return { win: myHp >= enHp, rounds: [], myMax: myHp, enMax: enHp, myHp, enHp };
}


app.post("/api/pets/battle", requireAuth, async (req, res) => {
  const ownedId = Number(req.body?.ownedPetId);
  if (!Number.isInteger(ownedId)) {
    return res.status(400).json({ ok: false, error: "ownedPetId required." });
  }

  const client = await pool.connect();
  try {
    await ensurePetTables();
    await ensureArenaTables();

    const petRes = await client.query(
      `SELECT * FROM owned_pets WHERE id = $1 AND member_id = $2`,
      [ownedId, req.member.id]
    );
    if (!petRes.rows.length) {
      return res.status(404).json({ ok: false, error: "Pet not found in My Pets." });
    }
    const pet = petRes.rows[0];
    const tierKey = pickTier(req.body?.tier, pet.level);
    const tier = BATTLE_TIERS[tierKey];

    if (String(pet.pet_status || "ACTIVE") === "RUNAWAY") {
      return res.status(400).json({
        ok: false,
        error: "Pet ran away from lack of care. Rescue or Feed/Water first."
      });
    }
    if (Number(pet.hunger != null ? pet.hunger : 100) < 15 || Number(pet.thirst != null ? pet.thirst : 100) < 15) {
      return res.status(400).json({
        ok: false,
        error: "Pet is too hungry or thirsty to fight. Feed and give water first."
      });
    }
    if (Number(pet.energy) < tier.energy) {
      return res.status(400).json({
        ok: false,
        error: "Pet needs more energy for " + tier.label + " (" + tier.energy + " required)."
      });
    }

    // Win-to-earn battle charges (base 5, +1 per win, max 15)
    const spent = await spendBattleCharge(client, req.member.id);
    if (spent.error) {
      return res.status(400).json({
        ok: false,
        error: spent.error,
        charges: spent.charges
      });
    }
    const day = spent.day;

    // Player combat stats
    const lv = Number(pet.level) || 1;
    let gearBonus = { atk: 0, def: 0, hp: 0, spd: 0 };
    try {
      await ensureGearTables();
      const emap = await getPetEquipmentMap(client, ownedId);
      gearBonus = sumGearBonuses(emap);
    } catch (e) {}
    const my = {
      name: pet.name,
      level: lv,
      hp: Number(pet.hp) + lv * 8 + (gearBonus.hp || 0),
      maxHp: Number(pet.hp) + lv * 8 + (gearBonus.hp || 0),
      atk: Number(pet.atk) + lv * 2 + (gearBonus.atk || 0),
      def: Number(pet.def) + Math.floor(lv * 0.8) + (gearBonus.def || 0),
      spd: Number(pet.spd) + Math.floor(lv * 0.5) + (gearBonus.spd || 0)
    };
    const myEl = pet.element || "Earth";

    // Scaled wild foe from catalog
    let foePool = AMT_PETS.filter(p => p.id !== pet.pet_id && p.name !== pet.name);
    if (!foePool.length) foePool = AMT_PETS.slice();
    const wild = foePool[Math.floor(Math.random() * foePool.length)] || AMT_PETS[0];
    const mult = tier.mult * (0.97 + Math.random() * 0.08);
    const en = {
      name: tier.label + " " + wild.name,
      hp: Math.max(30, Math.round(my.hp * mult)),
      atk: Math.max(8, Math.round(my.atk * mult * 0.95)),
      def: Math.max(5, Math.round(my.def * mult * 0.9)),
      spd: Math.max(5, Math.round(my.spd * (0.9 + Math.random() * 0.25)))
    };
    const enEl = wild.element || "Earth";

    const sim = simulateBattle(
      { ...my, name: pet.name },
      { ...en, name: en.name },
      myEl,
      enEl
    );

    const win = sim.win;
    const rel = elementRelation(myEl, enEl);
    let reward = 0;
    if (win) {
      reward =
        tier.rewardMin +
        Math.random() * (tier.rewardMax - tier.rewardMin);
      if (rel.key === "advantage") reward *= 1.15;
      reward = Math.round(reward * 100) / 100;
    } else {
      reward = 0.05;
    }

    await client.query(
      `UPDATE owned_pets SET energy = GREATEST(0, energy - $1),
        exp = COALESCE(exp, 0) + $2 WHERE id = $3`,
      [tier.energy, win ? 20 + Math.floor(tier.mult * 15) : 8, ownedId]
    );
    const petAfterBattle = await applyLevelAndRarity(
      client,
      ownedId,
      req.member.id
    );
    const chargeInfo = await applyBattleWinCharges(client, req.member.id, day, win);

    // Win-streak AMT bonuses (3 / 5 / 7)
    let streakBonusAmt = 0;
    let streakMsg = "";
    if (win && chargeInfo.streak === 3) { streakBonusAmt = 0.35; streakMsg = "🔥 3-win streak +0.35 AMT"; }
    if (win && chargeInfo.streak === 5) { streakBonusAmt = 0.80; streakMsg = "🔥 5-win streak +0.80 AMT"; }
    if (win && chargeInfo.streak === 7) { streakBonusAmt = 1.50; streakMsg = "🔥 7-win streak +1.50 AMT"; }
    reward = Math.round((reward + streakBonusAmt) * 100) / 100;

    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference)
       VALUES ($1,$2,'PET_BATTLE',$3)`,
      [req.member.id, reward, makeReference("AMT-BATTLE")]
    );
    await client.query(
      `INSERT INTO pet_battles
        (member_id, owned_pet_id, opponent_name, result, reward_amt)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.member.id, ownedId, en.name, win ? "WIN" : "LOSS", reward]
    );

    // Material drops (cores / gems) on win
    let drops = [];
    if (win) {
      try {
        await ensureGearTables();
        if (Math.random() < 0.55) {
          await addMaterial(client, req.member.id, "upgrade_core", 1);
          drops.push("Upgrade Core x1");
        }
        if (Math.random() < 0.35) {
          const gems = ["gem_atk_1", "gem_hp_1", "gem_def_1"];
          const g = gems[Math.floor(Math.random() * gems.length)];
          await addMaterial(client, req.member.id, g, 1);
          drops.push((getMaterial(g) || {}).name || g);
        }
        if (tierKey === "elite" || tierKey === "mythic") {
          if (Math.random() < 0.2) {
            const gems2 = ["gem_atk_2", "gem_hp_2", "gem_def_2"];
            const g2 = gems2[Math.floor(Math.random() * gems2.length)];
            await addMaterial(client, req.member.id, g2, 1);
            drops.push((getMaterial(g2) || {}).name || g2);
          }
        }
      } catch (e) { console.warn("drop", e.message); }
    }

    const underdog = false;
    const repInfo = await applyBattleRep(client, req.member.id, ownedId, win, tierKey, underdog);

    res.json({
      ok: true,
      result: win ? "WIN" : "LOSS",
      drops,
      tier: tierKey,
      tierLabel: tier.label,
      chargesLeft: chargeInfo.charges,
      winStreak: chargeInfo.streak,
      chargeBonus: [chargeInfo.message, streakMsg].filter(Boolean).join(" · "),
      streakBonusAmt,
      elementRelation: rel.key,
      elementLabel: rel.label,
      elementMult: rel.mult,
      petRepGained: repInfo.petRep,
      ownerRepGained: repInfo.ownerRep,
      petLevel: petAfterBattle && petAfterBattle.level,
      petRarity: petAfterBattle && petAfterBattle.rarity,
      petExp: petAfterBattle && petAfterBattle.exp,
      milestones: (petAfterBattle && petAfterBattle._milestones) || [],
      opponent: en.name,
      opponentElement: enEl,
      opponentImage: wild.image || null,
      opponentPetId: wild.id,
      opponentEmoji:
        ({
          Earth: "🌍", Water: "💧", Nature: "🌿", Ice: "❄️",
          Fire: "🔥", Wind: "🌬️", Thunder: "⚡", Shadow: "🌑", Light: "✨", Cosmic: "🌌"
        }[enEl] || "🐾"),
      petName: pet.name,
      petElement: myEl,
      petImage: pet.image || null,
      reward,
      myMaxHp: sim.myMax,
      enMaxHp: sim.enMax,
      rounds: sim.rounds,
      mode: "cpu"
    });
  } catch (error) {
    console.error("PET BATTLE ERROR:", error);
    res.status(500).json({ ok: false, error: "Battle failed." });
  } finally {
    client.release();
  }
});

/* List your pet in PvP Arena */
app.post("/api/pets/arena/list", requireAuth, async (req, res) => {
  const ownedId = Number(req.body?.ownedPetId);
  if (!Number.isInteger(ownedId)) {
    return res.status(400).json({ ok: false, error: "ownedPetId required." });
  }
  try {
    await ensurePetTables();
    await ensureArenaTables();
    const petRes = await pool.query(
      `SELECT * FROM owned_pets WHERE id = $1 AND member_id = $2`,
      [ownedId, req.member.id]
    );
    if (!petRes.rows.length) {
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    const pet = petRes.rows[0];
    const lv = Number(pet.level) || 1;
    // One active listing per member
    await pool.query(
      `UPDATE pet_arena SET active = FALSE, updated_at = NOW()
       WHERE member_id = $1 AND active = TRUE`,
      [req.member.id]
    );
    const ins = await pool.query(
      `INSERT INTO pet_arena
        (member_id, owned_pet_id, pet_name, pet_element, pet_image,
         level, hp, atk, def, spd, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)
       RETURNING id, rating, level, pet_name`,
      [
        req.member.id,
        ownedId,
        pet.name,
        pet.element || "Earth",
        pet.image || null,
        lv,
        Number(pet.hp) + lv * 8,
        Number(pet.atk) + lv * 2,
        Number(pet.def) + Math.floor(lv * 0.8),
        Number(pet.spd) + Math.floor(lv * 0.5)
      ]
    );
    res.json({
      ok: true,
      arenaId: ins.rows[0].id,
      rating: ins.rows[0].rating,
      message: pet.name + " listed in PvP Arena (Lv" + lv + ")"
    });
  } catch (e) {
    console.error("ARENA LIST:", e);
    res.status(500).json({ ok: false, error: "Could not list in arena." });
  }
});

app.get("/api/pets/arena", requireAuth, async (req, res) => {
  try {
    await ensureArenaTables();
    const rows = await pool.query(
      `SELECT a.id, a.pet_name, a.pet_element, a.pet_image, a.level,
              a.hp, a.atk, a.def, a.spd, a.rating, a.member_id,
              m.username
       FROM pet_arena a
       LEFT JOIN members m ON m.id = a.member_id
       WHERE a.active = TRUE AND a.member_id <> $1
       ORDER BY a.rating DESC, a.level DESC
       LIMIT 40`,
      [req.member.id]
    );
    res.json({ ok: true, listings: rows.rows });
  } catch (e) {
    console.error("ARENA LIST GET:", e);
    res.status(500).json({ ok: false, error: "Arena unavailable." });
  }
});


app.get("/api/pets/arena/mine", requireAuth, async (req, res) => {
  try {
    await ensureArenaTables();
    const rows = await pool.query(
      `SELECT id, pet_name, pet_element, pet_image, level, hp, atk, def, spd, rating, active, owned_pet_id
       FROM pet_arena
       WHERE member_id = $1 AND active = TRUE
       ORDER BY updated_at DESC
       LIMIT 5`,
      [req.member.id]
    );
    res.json({ ok: true, listings: rows.rows });
  } catch (e) {
    console.error("ARENA MINE:", e);
    res.status(500).json({ ok: false, error: "Could not load your arena listing." });
  }
});

app.post("/api/pets/arena/unlist", requireAuth, async (req, res) => {
  const arenaId = req.body?.arenaId != null ? Number(req.body.arenaId) : null;
  try {
    await ensureArenaTables();
    let result;
    if (Number.isInteger(arenaId)) {
      result = await pool.query(
        `UPDATE pet_arena SET active = FALSE, updated_at = NOW()
         WHERE id = $1 AND member_id = $2 AND active = TRUE
         RETURNING id, pet_name`,
        [arenaId, req.member.id]
      );
    } else {
      result = await pool.query(
        `UPDATE pet_arena SET active = FALSE, updated_at = NOW()
         WHERE member_id = $1 AND active = TRUE
         RETURNING id, pet_name`,
        [req.member.id]
      );
    }
    if (!result.rows.length) {
      return res.json({ ok: true, unlisted: 0, message: "No active arena listing." });
    }
    res.json({
      ok: true,
      unlisted: result.rows.length,
      message: "Unlisted " + result.rows.map(r => r.pet_name).join(", ")
    });
  } catch (e) {
    console.error("ARENA UNLIST:", e);
    res.status(500).json({ ok: false, error: "Could not unlist." });
  }
});

app.get("/api/pets/arena/:arenaId", requireAuth, async (req, res) => {
  const arenaId = Number(req.params.arenaId);
  if (!Number.isInteger(arenaId)) {
    return res.status(400).json({ ok: false, error: "Invalid arena id." });
  }
  try {
    await ensureArenaTables();
    const rows = await pool.query(
      `SELECT a.id, a.pet_name, a.pet_element, a.pet_image, a.level,
              a.hp, a.atk, a.def, a.spd, a.rating, a.member_id,
              m.username
       FROM pet_arena a
       LEFT JOIN members m ON m.id = a.member_id
       WHERE a.id = $1 AND a.active = TRUE`,
      [arenaId]
    );
    if (!rows.rows.length) {
      return res.status(404).json({ ok: false, error: "Opponent not found or unlisted." });
    }
    res.json({ ok: true, opponent: rows.rows[0] });
  } catch (e) {
    console.error("ARENA VIEW:", e);
    res.status(500).json({ ok: false, error: "Could not load opponent." });
  }
});

app.post("/api/pets/arena/challenge", requireAuth, async (req, res) => {
  const ownedId = Number(req.body?.ownedPetId);
  const arenaId = Number(req.body?.arenaId);
  if (!Number.isInteger(ownedId) || !Number.isInteger(arenaId)) {
    return res.status(400).json({
      ok: false,
      error: "ownedPetId and arenaId required."
    });
  }
  const client = await pool.connect();
  try {
    await ensurePetTables();
    await ensureArenaTables();

    const day = new Date().toISOString().slice(0, 10);
    await client.query(
      `INSERT INTO pet_battle_daily (member_id, battle_date, cpu_count, pvp_count)
       VALUES ($1, $2::date, 0, 0)
       ON CONFLICT (member_id, battle_date) DO UPDATE SET member_id = EXCLUDED.member_id`,
      [req.member.id, day]
    );
    const daily = await client.query(
      `SELECT pvp_count FROM pet_battle_daily
       WHERE member_id = $1 AND battle_date = $2::date`,
      [req.member.id, day]
    );
    if (Number(daily.rows[0]?.pvp_count || 0) >= 15) {
      return res.status(400).json({
        ok: false,
        error: "Daily PvP limit reached (15)."
      });
    }

    const petRes = await client.query(
      `SELECT * FROM owned_pets WHERE id = $1 AND member_id = $2`,
      [ownedId, req.member.id]
    );
    if (!petRes.rows.length) {
      return res.status(404).json({ ok: false, error: "Your pet not found." });
    }
    const pet = petRes.rows[0];
    if (Number(pet.energy) < 18) {
      return res.status(400).json({
        ok: false,
        error: "PvP needs 18 energy. Care / energy pack first."
      });
    }

    const arenaRes = await client.query(
      `SELECT * FROM pet_arena WHERE id = $1 AND active = TRUE`,
      [arenaId]
    );
    if (!arenaRes.rows.length) {
      return res.status(404).json({ ok: false, error: "Arena opponent not found." });
    }
    const foe = arenaRes.rows[0];
    if (Number(foe.member_id) === Number(req.member.id)) {
      return res.status(400).json({ ok: false, error: "Cannot fight your own pet." });
    }

    const lv = Number(pet.level) || 1;
    const my = {
      name: pet.name,
      level: lv,
      hp: Number(pet.hp) + lv * 8,
      maxHp: Number(pet.hp) + lv * 8,
      atk: Number(pet.atk) + lv * 2,
      def: Number(pet.def) + Math.floor(lv * 0.8),
      spd: Number(pet.spd) + Math.floor(lv * 0.5)
    };
    const en = {
      name: foe.pet_name + " (PvP)",
      hp: Number(foe.hp),
      atk: Number(foe.atk),
      def: Number(foe.def),
      spd: Number(foe.spd)
    };
    const sim = simulateBattle(my, en, pet.element, foe.pet_element);
    const win = sim.win;
    const reward = win ? 0.8 + Math.random() * 1.2 : 0.1;
    const rewardR = Math.round(reward * 100) / 100;

    await client.query(
      `UPDATE owned_pets SET energy = GREATEST(0, energy - 18),
        exp = COALESCE(exp, 0) + $1 WHERE id = $2`,
      [win ? 40 : 12, ownedId]
    );
    const petAfter = await applyLevelAndRarity(client, ownedId, req.member.id);

    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference)
       VALUES ($1,$2,'PET_PVP',$3)`,
      [req.member.id, rewardR, makeReference("AMT-PVP")]
    );
    const repPvp = await applyBattleRep(client, req.member.id, ownedId, win, "pvp", false);

    // Rating
    const delta = win ? 18 : -12;
    await client.query(
      `UPDATE pet_arena SET rating = GREATEST(100, rating + $1), updated_at = NOW()
       WHERE id = $2`,
      [win ? -10 : 8, arenaId]
    );

    await client.query(
      `INSERT INTO pet_pvp_battles
        (attacker_id, defender_id, attacker_pet_id, defender_arena_id, result, reward_amt)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        req.member.id,
        foe.member_id,
        ownedId,
        arenaId,
        win ? "WIN" : "LOSS",
        rewardR
      ]
    );
    await client.query(
      `UPDATE pet_battle_daily SET pvp_count = pvp_count + 1
       WHERE member_id = $1 AND battle_date = $2::date`,
      [req.member.id, day]
    );

    res.json({
      ok: true,
      result: win ? "WIN" : "LOSS",
      mode: "pvp",
      tierLabel: "PvP",
      petRepGained: repPvp && repPvp.petRep,
      ownerRepGained: repPvp && repPvp.ownerRep,
      opponent: en.name,
      opponentElement: foe.pet_element,
      opponentImage: foe.pet_image,
      petName: pet.name,
      petElement: pet.element,
      petImage: pet.image,
      reward: rewardR,
      myMaxHp: sim.myMax,
      enMaxHp: sim.enMax,
      rounds: sim.rounds,
      petLevel: petAfter && petAfter.level,
      milestones: (petAfter && petAfter._milestones) || []
    });
  } catch (e) {
    console.error("PVP CHALLENGE:", e);
    res.status(500).json({ ok: false, error: "PvP battle failed." });
  } finally {
    client.release();
  }
});


/* =========================================================
   PET SKILLS + SQUAD 3v3 / 4v4
========================================================= */

const PET_SKILLS = {
  Fire: [
    { id: "ember", name: "Ember Strike", minLv: 1, power: 1.25, kind: "attack", desc: "Fire hit · 125% ATK" },
    { id: "inferno", name: "Inferno", minLv: 12, power: 1.55, kind: "attack", desc: "Heavy fire · 155% ATK" }
  ],
  Water: [
    { id: "splash", name: "Aqua Pulse", minLv: 1, power: 1.2, kind: "attack", desc: "Water hit · 120% ATK" },
    { id: "tide", name: "Tidal Guard", minLv: 12, power: 0, kind: "defend", desc: "Raise DEF next hit" }
  ],
  Nature: [
    { id: "vine", name: "Vine Lash", minLv: 1, power: 1.2, kind: "attack", desc: "Nature hit · 120% ATK" },
    { id: "bloom", name: "Bloom Heal", minLv: 10, power: 0.18, kind: "heal", desc: "Heal 18% max HP" }
  ],
  Thunder: [
    { id: "spark", name: "Spark", minLv: 1, power: 1.3, kind: "attack", desc: "Thunder · 130% ATK" },
    { id: "storm", name: "Storm Bolt", minLv: 15, power: 1.6, kind: "attack", desc: "Heavy thunder · 160% ATK" }
  ],
  Earth: [
    { id: "quake", name: "Quake", minLv: 1, power: 1.15, kind: "attack", desc: "Earth hit · 115% ATK" },
    { id: "shell", name: "Stone Shell", minLv: 10, power: 0, kind: "defend", desc: "Raise DEF next hit" }
  ],
  Ice: [
    { id: "frost", name: "Frostbite", minLv: 1, power: 1.2, kind: "attack", desc: "Ice hit · 120% ATK" },
    { id: "freeze", name: "Deep Freeze", minLv: 14, power: 1.45, kind: "attack", desc: "Heavy ice · 145% ATK" }
  ],
  Wind: [
    { id: "gust", name: "Gust", minLv: 1, power: 1.2, kind: "attack", desc: "Wind hit · 120% ATK" },
    { id: "cyclone", name: "Cyclone", minLv: 12, power: 1.5, kind: "attack", desc: "Heavy wind · 150% ATK" }
  ],
  Shadow: [
    { id: "shade", name: "Shadow Strike", minLv: 1, power: 1.3, kind: "attack", desc: "Dark hit · 130% ATK" },
    { id: "void", name: "Void Pulse", minLv: 15, power: 1.6, kind: "attack", desc: "Heavy shadow · 160% ATK" }
  ],
  Light: [
    { id: "ray", name: "Holy Ray", minLv: 1, power: 1.25, kind: "attack", desc: "Light hit · 125% ATK" },
    { id: "bless", name: "Blessing", minLv: 12, power: 0.2, kind: "heal", desc: "Heal 20% max HP" }
  ],
  Cosmic: [
    { id: "nova", name: "Star Nova", minLv: 1, power: 1.35, kind: "attack", desc: "Cosmic hit · 135% ATK" },
    { id: "galaxy", name: "Galaxy Burst", minLv: 18, power: 1.7, kind: "attack", desc: "Heavy cosmic · 170% ATK" }
  ]
};

function skillsForPet(element, level) {
  const el = String(element || "Earth");
  const list = PET_SKILLS[el] || PET_SKILLS.Earth;
  const lv = Number(level) || 1;
  return list.filter(s => lv >= s.minLv).map(s => ({
    id: s.id,
    name: s.name,
    minLv: s.minLv,
    kind: s.kind,
    power: s.power,
    desc: s.desc,
    unlocked: true
  }));
}

function allSkillsPreview(element, level) {
  const el = String(element || "Earth");
  const list = PET_SKILLS[el] || PET_SKILLS.Earth;
  const lv = Number(level) || 1;
  return list.map(s => ({
    id: s.id,
    name: s.name,
    minLv: s.minLv,
    kind: s.kind,
    power: s.power,
    desc: s.desc,
    unlocked: lv >= s.minLv
  }));
}

function pickSkill(element, level) {
  const unlocked = skillsForPet(element, level);
  if (!unlocked.length) return null;
  // Prefer stronger skill ~35% if available
  if (unlocked.length > 1 && Math.random() < 0.35) {
    return unlocked[unlocked.length - 1];
  }
  if (Math.random() < 0.45) return unlocked[0];
  return null; // basic attack
}

async function ensureSquadTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_squads (
      member_id BIGINT NOT NULL REFERENCES members(id),
      slot SMALLINT NOT NULL CHECK (slot >= 1 AND slot <= 4),
      owned_pet_id BIGINT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (member_id, slot)
    )
  `);
}

function combatStatsFromOwned(pet, gearBonus) {
  const lv = Number(pet.level) || 1;
  const b = gearBonus || { atk: 0, def: 0, hp: 0, spd: 0 };
  return {
    ownedId: pet.id,
    name: pet.name,
    element: pet.element || "Earth",
    image: pet.image || null,
    level: lv,
    hp: Number(pet.hp) + lv * 8 + (b.hp || 0),
    atk: Number(pet.atk) + lv * 2 + (b.atk || 0),
    def: Number(pet.def) + Math.floor(lv * 0.8) + (b.def || 0),
    spd: Number(pet.spd) + Math.floor(lv * 0.5) + (b.spd || 0),
    maxHp: Number(pet.hp) + lv * 8 + (b.hp || 0)
  };
}

/** Single duel with skills */
function simulateBattleWithSkills(my, en, myEl, enEl) {
  let myHp = my.hp;
  let enHp = en.hp;
  const myMax = my.maxHp || my.hp;
  const enMax = en.maxHp || en.hp;
  let myDefBuf = 0;
  let enDefBuf = 0;
  const rounds = [];
  let round = 0;
  const maxRounds = 12;

  while (myHp > 0 && enHp > 0 && round < maxRounds) {
    round += 1;
    const myFirst = my.spd + Math.random() * 8 >= en.spd + Math.random() * 8;

    const turn = (attacker, defender, actor, atkEl, defEl, isMe) => {
      const skill = pickSkill(atkEl, attacker.level || 1);
      let dmg = 0;
      let text = "";
      const defExtra = isMe ? enDefBuf : myDefBuf;

      if (skill && skill.kind === "heal") {
        const heal = Math.round((isMe ? myMax : enMax) * skill.power);
        if (isMe) {
          myHp = Math.min(myMax, myHp + heal);
        } else {
          enHp = Math.min(enMax, enHp + heal);
        }
        text = attacker.name + " uses " + skill.name + " · +" + heal + " HP";
        // clear opposite def buf not needed
      } else if (skill && skill.kind === "defend") {
        if (isMe) myDefBuf = Math.round(attacker.def * 0.5);
        else enDefBuf = Math.round(attacker.def * 0.5);
        text = attacker.name + " uses " + skill.name + " · DEF up";
      } else {
        const power = skill && skill.kind === "attack" ? skill.power : 1;
        const em = elementMult(atkEl, defEl);
        const def = (defender.def + defExtra) * 0.35;
        dmg = Math.max(4, Math.round((attacker.atk * power - def) * em + Math.random() * 8));
        if (isMe) {
          enHp = Math.max(0, enHp - dmg);
          enDefBuf = 0;
        } else {
          myHp = Math.max(0, myHp - dmg);
          myDefBuf = 0;
        }
        if (skill && skill.kind === "attack") {
          text = attacker.name + " · " + skill.name + " for " + dmg +
            (em > 1 ? " (super!)" : em < 1 ? " (resisted)" : "");
        } else {
          text = attacker.name + " hits " + defender.name + " for " + dmg +
            (em > 1 ? " (super!)" : em < 1 ? " (resisted)" : "");
        }
      }
      rounds.push({
        round,
        actor,
        dmg,
        skill: skill ? skill.name : null,
        myHp,
        enHp,
        text
      });
    };

    if (myFirst) {
      turn(my, en, "you", myEl, enEl, true);
      if (enHp <= 0) break;
      turn(en, my, "enemy", enEl, myEl, false);
    } else {
      turn(en, my, "enemy", enEl, myEl, false);
      if (myHp <= 0) break;
      turn(my, en, "you", myEl, enEl, true);
    }
  }

  // Strict outcome (fixes inverted Victory/Defeat reports)
  let win = false;
  if (enHp <= 0 && myHp > 0) win = true;          // clear win
  else if (myHp <= 0 && enHp > 0) win = false;     // clear loss
  else if (myHp <= 0 && enHp <= 0) win = false;    // mutual KO = loss
  else win = myHp > enHp;                          // timeout: higher HP wins
  return { win, rounds, myMax, enMax, myHp, enHp };
}

// Patch: use skills in existing simulateBattle path — replace function body calls
// We keep simulateBattle for compatibility; squad uses simulateBattleWithSkills

app.get("/api/pets/battle-charges", requireAuth, async (req, res) => {
  try {
    await ensureArenaTables();
    const { day, row } = await getBattleDay(null, req.member.id);
    res.json({
      ok: true,
      date: day,
      charges: Number(row.charges ?? BATTLE_BASE_CHARGES),
      wins: Number(row.wins || 0),
      streak: Number(row.streak || 0),
      bonusEarned: Number(row.bonus_earned || 0),
      baseCharges: BATTLE_BASE_CHARGES,
      maxCharges: BATTLE_MAX_CHARGES,
      unlimited: !!BATTLE_UNLIMITED,
      rule: BATTLE_UNLIMITED
        ? "Unlimited battles — play as much as you want. Pet energy still applies."
        : "Start with 5 charges. Each win +1 charge (max 15). 3-win streak +1 extra. Resets daily."
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Could not load charges." });
  }
});


/* ---------- Claim care/train session ---------- */

/* Rescue runaway pet — 1 AMT, restores needs */

/* ---- Star upgrade ★1–★5 ----
   Cost: mineral_ore + upgrade_core + AMT
   Each star: +HP +ATK +DEF +SPD bonuses
------------------------------------------------ */
function starUpgradeCost(currentStars) {
  const s = Math.max(1, Math.min(4, Number(currentStars) || 1));
  // cost to go from s → s+1 (sustainable early game)
  const table = {
    1: { minerals: 1, cores: 1, amt: 0.15, hp: 15, atk: 4, def: 4, spd: 3 },
    2: { minerals: 2, cores: 1, amt: 0.35, hp: 25, atk: 6, def: 6, spd: 4 },
    3: { minerals: 4, cores: 2, amt: 0.7, hp: 40, atk: 9, def: 9, spd: 6 },
    4: { minerals: 8, cores: 3, amt: 1.5, hp: 60, atk: 14, def: 14, spd: 9 }
  };
  return table[s] || table[1];
}

app.post("/api/pets/star-upgrade", requireAuth, async (req, res) => {
  const ownedId = Number(req.body?.ownedPetId);
  if (!Number.isFinite(ownedId) || ownedId < 1) {
    return res.status(400).json({ ok: false, error: "ownedPetId required." });
  }
  const client = await pool.connect();
  try {
    await ensurePetTables();
    await ensureGearTables();
    await client.query("BEGIN");
    const petR = await client.query(
      `SELECT * FROM owned_pets WHERE id = $1 AND member_id = $2 FOR UPDATE`,
      [ownedId, req.member.id]
    );
    if (!petR.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    const pet = petR.rows[0];
    if (String(pet.pet_status || "ACTIVE") === "RUNAWAY") {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Rescue pet first before star upgrade." });
    }
    let stars = Number(pet.stars != null ? pet.stars : 1);
    if (stars < 1) stars = 1;
    if (stars >= 5) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Already max ★5." });
    }
    const cost = starUpgradeCost(stars);
    // Friendly pre-check (bag / shop)
    const matRows = await client.query(
      `SELECT material_id, qty FROM member_materials
       WHERE member_id = $1 AND material_id IN ('mineral_ore','upgrade_core')`,
      [req.member.id]
    );
    const haveMap = {};
    for (const row of matRows.rows) haveMap[row.material_id] = Number(row.qty) || 0;
    const haveMin = haveMap.mineral_ore || 0;
    const haveCore = haveMap.upgrade_core || 0;
    const bal = await getBalance(req.member.id, client);
    const missing = [];
    if (haveMin < cost.minerals) missing.push("Mineral Ore " + haveMin + "/" + cost.minerals);
    if (haveCore < cost.cores) missing.push("Upgrade Core " + haveCore + "/" + cost.cores);
    if (bal < cost.amt) missing.push("AMT " + bal + "/" + cost.amt);
    if (missing.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "Need for next ★: " + missing.join(" · ") + ". Buy in Items/Materials shop or loot from Map grind.",
        need: cost,
        have: { mineral_ore: haveMin, upgrade_core: haveCore, amt: bal }
      });
    }
    await spendMaterial(client, req.member.id, "mineral_ore", cost.minerals);
    await spendMaterial(client, req.member.id, "upgrade_core", cost.cores);
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'PET_STAR',$3)`,
      [req.member.id, -cost.amt, makeReference("AMT-STAR")]
    );
    const newStars = stars + 1;
    await client.query(
      `UPDATE owned_pets SET
        stars = $1,
        hp = COALESCE(hp,0) + $2,
        atk = COALESCE(atk,0) + $3,
        def = COALESCE(def,0) + $4,
        spd = COALESCE(spd,0) + $5
       WHERE id = $6`,
      [newStars, cost.hp, cost.atk, cost.def, cost.spd, ownedId]
    );
    const after = await client.query(`SELECT * FROM owned_pets WHERE id = $1`, [ownedId]);
    await client.query("COMMIT");
    res.json({
      ok: true,
      stars: newStars,
      starsLabel: "★".repeat(newStars),
      cost,
      pet: after.rows[0],
      message: "Star up! Now " + "★".repeat(newStars) + " (" + newStars + "/5) · +" + cost.hp + " HP +" + cost.atk + " ATK +" + cost.def + " DEF"
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    const code = e.status || 500;
    if (code >= 500) console.error("STAR UP:", e);
    res.status(code).json({ ok: false, error: e.message || "Star upgrade failed." });
  } finally {
    client.release();
  }
});

app.get("/api/pets/star-cost/:ownedPetId", requireAuth, async (req, res) => {
  try {
    const ownedId = Number(req.params.ownedPetId);
    const r = await pool.query(
      `SELECT stars FROM owned_pets WHERE id = $1 AND member_id = $2`,
      [ownedId, req.member.id]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: "Pet not found." });
    let stars = Number(r.rows[0].stars != null ? r.rows[0].stars : 1);
    if (stars >= 5) return res.json({ ok: true, stars: 5, max: true, cost: null });
    const cost = starUpgradeCost(stars);
    res.json({ ok: true, stars, max: false, nextStars: stars + 1, cost });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Failed." });
  }
});

app.post("/api/pets/rescue", requireAuth, async (req, res) => {
  const ownedId = Number(req.body?.ownedPetId);
  if (!Number.isFinite(ownedId) || ownedId < 1) {
    return res.status(400).json({ ok: false, error: "ownedPetId required." });
  }
  const cost = 1.0;
  const client = await pool.connect();
  try {
    await ensurePetTables();
    await client.query("BEGIN");
    const pet = await client.query(
      `SELECT * FROM owned_pets WHERE id = $1 AND member_id = $2 FOR UPDATE`,
      [ownedId, req.member.id]
    );
    if (!pet.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    if (String(pet.rows[0].pet_status || "ACTIVE") !== "RUNAWAY") {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Pet did not run away." });
    }
    const bal = await getBalance(req.member.id, client);
    if (bal < cost) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Need 1 AMT to rescue." });
    }
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'PET_RESCUE',$3)`,
      [req.member.id, -cost, makeReference("AMT-RESCUE")]
    );
    await client.query(
      `UPDATE owned_pets SET
        pet_status = 'ACTIVE', hunger = 60, thirst = 60,
        energy = LEAST(100, COALESCE(energy,0) + 20),
        happiness = LEAST(100, COALESCE(happiness,0) + 20),
        last_needs_at = NOW()
       WHERE id = $1`,
      [ownedId]
    );
    await client.query("COMMIT");
    res.json({ ok: true, message: "Pet rescued! Keep feeding & watering.", cost });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("RESCUE:", e);
    res.status(500).json({ ok: false, error: "Rescue failed." });
  } finally {
    client.release();
  }
});

app.post("/api/pets/claim-session", requireAuth, async (req, res) => {
  const ownedId = Number(req.body?.ownedPetId);
  if (!Number.isFinite(ownedId) || ownedId < 1) {
    return res.status(400).json({ ok: false, error: "ownedPetId required." });
  }
  const client = await pool.connect();
  try {
    await ensurePetTables();
    await client.query("BEGIN");
    const pet = await client.query(
      `SELECT * FROM owned_pets WHERE id = $1 AND member_id = $2 FOR UPDATE`,
      [ownedId, req.member.id]
    );
    if (!pet.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    const row = pet.rows[0];
    if (!row.session_ends_at) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "No active session." });
    }
    if (new Date(row.session_ends_at) > new Date()) {
      await client.query("ROLLBACK");
      const left = Math.ceil((new Date(row.session_ends_at) - Date.now()) / 60000);
      return res.status(400).json({
        ok: false,
        error: "Session not finished yet. ~" + left + " min left.",
        sessionEndsAt: row.session_ends_at
      });
    }
    const xp = Number(row.session_xp) || 0;
    const st = String(row.session_stat || "");
    const isTrain = String(row.session_type || "").startsWith("train") || st;
    if (isTrain && st && ["hp", "atk", "def", "spd"].includes(st)) {
      const gain = st === "hp" ? 12 : (st === "atk" ? 6 : 4);
      await client.query(
        `UPDATE owned_pets SET
          ${st} = COALESCE(${st}, 0) + $1,
          exp = COALESCE(exp, 0) + $2,
          session_type = NULL, session_ends_at = NULL, session_stat = NULL,
          session_xp = 0, session_cost = 0
         WHERE id = $3`,
        [gain, xp, ownedId]
      );
    } else {
      await client.query(
        `UPDATE owned_pets SET
          exp = COALESCE(exp, 0) + $1,
          session_type = NULL, session_ends_at = NULL, session_stat = NULL,
          session_xp = 0, session_cost = 0
         WHERE id = $2`,
        [xp, ownedId]
      );
    }
    const petAfter = await applyLevelAndRarity(client, ownedId, req.member.id);
    await client.query("COMMIT");
    let claimMsg = "Session claimed · +" + xp + " XP";
    if (isTrain && st && ["hp", "atk", "def", "spd"].includes(st)) {
      const g = st === "hp" ? 12 : (st === "atk" ? 6 : 4);
      claimMsg = "Train claimed · " + st.toUpperCase() + " +" + g + " · +" + xp + " XP";
    }
    res.json({
      ok: true, xpGained: xp, pet: petAfter,
      level: petAfter && petAfter.level,
      trained: isTrain ? st : null,
      message: claimMsg
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("CLAIM SESSION:", e);
    res.status(500).json({ ok: false, error: "Claim failed." });
  } finally {
    client.release();
  }
});


app.post("/api/pets/cancel-session", requireAuth, async (req, res) => {
  const ownedId = Number(req.body?.ownedPetId);
  if (!Number.isFinite(ownedId) || ownedId < 1) {
    return res.status(400).json({ ok: false, error: "ownedPetId required." });
  }
  const client = await pool.connect();
  try {
    await ensurePetTables();
    await client.query("BEGIN");
    const pet = await client.query(
      `SELECT * FROM owned_pets WHERE id = $1 AND member_id = $2 FOR UPDATE`,
      [ownedId, req.member.id]
    );
    if (!pet.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    if (!pet.rows[0].session_ends_at) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "No active session to cancel." });
    }
    await client.query(
      `UPDATE owned_pets SET
        session_type = NULL, session_ends_at = NULL, session_stat = NULL,
        session_xp = 0, session_cost = 0
       WHERE id = $1`,
      [ownedId]
    );
    await client.query("COMMIT");
    res.json({
      ok: true,
      message: "Session cancelled (no XP). Fee not refunded. You can care/train again."
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ ok: false, error: "Cancel failed." });
  } finally {
    client.release();
  }
});

app.get("/api/pets/skills", requireAuth, async (req, res) => {
  try {
    const element = req.query.element || "Earth";
    const level = Number(req.query.level) || 1;
    res.json({
      ok: true,
      element,
      level,
      skills: allSkillsPreview(element, level)
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Skills unavailable." });
  }
});

app.get("/api/pets/squad", requireAuth, async (req, res) => {
  try {
    await ensurePetTables();
    await ensureSquadTables();
    const rows = await pool.query(
      `SELECT s.slot, s.owned_pet_id, p.name, p.element, p.image, p.level,
              p.hp, p.atk, p.def, p.spd, p.energy, p.rarity
       FROM pet_squads s
       JOIN owned_pets p ON p.id = s.owned_pet_id AND p.member_id = s.member_id
       WHERE s.member_id = $1
       ORDER BY s.slot ASC`,
      [req.member.id]
    );
    res.json({ ok: true, squad: rows.rows });
  } catch (e) {
    console.error("SQUAD GET:", e);
    res.status(500).json({ ok: false, error: "Could not load squad." });
  }
});

app.post("/api/pets/squad/set", requireAuth, async (req, res) => {
  // body: { slots: [ownedPetId|null, ...] } length 3 or 4
  const slots = Array.isArray(req.body?.slots) ? req.body.slots : [];
  const size = Number(req.body?.size) === 4 ? 4 : 3;
  if (slots.length < size) {
    return res.status(400).json({
      ok: false,
      error: "Need " + size + " pet ids in slots (use null for empty)."
    });
  }
  const ids = [];
  for (let i = 0; i < size; i++) {
    const id = slots[i] == null || slots[i] === "" ? null : Number(slots[i]);
    if (id != null && !Number.isInteger(id)) {
      return res.status(400).json({ ok: false, error: "Invalid pet id in slot " + (i + 1) });
    }
    if (id != null) ids.push(id);
  }
  if (ids.length < size) {
    return res.status(400).json({
      ok: false,
      error: "Fill all " + size + " slots with different pets."
    });
  }
  if (new Set(ids).size !== ids.length) {
    return res.status(400).json({ ok: false, error: "Duplicate pets in squad." });
  }

  const client = await pool.connect();
  try {
    await ensurePetTables();
    await ensureSquadTables();
    const owned = await client.query(
      `SELECT id FROM owned_pets WHERE member_id = $1 AND id = ANY($2::bigint[])`,
      [req.member.id, ids]
    );
    if (owned.rows.length !== ids.length) {
      return res.status(400).json({ ok: false, error: "All pets must be in your My Pets." });
    }
    await client.query(`DELETE FROM pet_squads WHERE member_id = $1`, [req.member.id]);
    for (let i = 0; i < size; i++) {
      await client.query(
        `INSERT INTO pet_squads (member_id, slot, owned_pet_id)
         VALUES ($1,$2,$3)`,
        [req.member.id, i + 1, ids[i]]
      );
    }
    res.json({ ok: true, size, message: size + "v" + size + " squad saved." });
  } catch (e) {
    console.error("SQUAD SET:", e);
    res.status(500).json({ ok: false, error: "Could not save squad." });
  } finally {
    client.release();
  }
});


/* =========================================================
   DAILY BOSS
========================================================= */
const DAILY_BOSSES = [
  { id: "ember", name: "Ember Tyrant", element: "Fire", mult: 1.45, reward: 1.8, exp: 55 },
  { id: "tide", name: "Abyss Leviathan", element: "Water", mult: 1.45, reward: 1.8, exp: 55 },
  { id: "grove", name: "Elder Grove", element: "Nature", mult: 1.40, reward: 1.6, exp: 50 },
  { id: "frost", name: "Frost Colossus", element: "Ice", mult: 1.50, reward: 2.0, exp: 60 },
  { id: "storm", name: "Storm Sovereign", element: "Thunder", mult: 1.50, reward: 2.0, exp: 60 },
  { id: "stone", name: "Stone Warden", element: "Earth", mult: 1.40, reward: 1.6, exp: 50 },
  { id: "void", name: "Void Herald", element: "Shadow", mult: 1.55, reward: 2.2, exp: 70 }
];

function getTodayBoss() {
  const dayIndex = Math.floor(Date.now() / 86400000);
  return DAILY_BOSSES[dayIndex % DAILY_BOSSES.length];
}

async function ensureBossTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_boss_daily (
      member_id BIGINT NOT NULL,
      boss_date DATE NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      defeated BOOLEAN NOT NULL DEFAULT FALSE,
      best_damage INT NOT NULL DEFAULT 0,
      PRIMARY KEY (member_id, boss_date)
    )
  `);
}

app.get("/api/pets/boss", requireAuth, async (req, res) => {
  try {
    await ensureBossTable();
    const boss = getTodayBoss();
    const day = new Date().toISOString().slice(0, 10);
    const r = await pool.query(
      `SELECT attempts, defeated, best_damage FROM pet_boss_daily
       WHERE member_id = $1 AND boss_date = $2::date`,
      [req.member.id, day]
    );
    const row = r.rows[0] || { attempts: 0, defeated: false, best_damage: 0 };
    res.json({
      ok: true,
      boss: {
        name: boss.name,
        element: boss.element,
        id: boss.id,
        reward: boss.reward,
        exp: boss.exp
      },
      attempts: Number(row.attempts) || 0,
      maxAttempts: 3,
      defeated: !!row.defeated,
      bestDamage: Number(row.best_damage) || 0,
      beats: ELEMENT_BEATS[boss.element] || null,
      hint: "Use element that beats " + boss.element + " for super effective damage"
    });
  } catch (e) {
    console.error("BOSS GET:", e);
    res.status(500).json({ ok: false, error: "Boss unavailable." });
  }
});

app.post("/api/pets/boss/fight", requireAuth, async (req, res) => {
  const ownedId = Number(req.body?.ownedPetId);
  if (!Number.isInteger(ownedId)) {
    return res.status(400).json({ ok: false, error: "ownedPetId required." });
  }
  const client = await pool.connect();
  try {
    await ensurePetTables();
    await ensureBossTable();
    const boss = getTodayBoss();
    const day = new Date().toISOString().slice(0, 10);

    await client.query("BEGIN");
    await client.query(
      `INSERT INTO pet_boss_daily (member_id, boss_date, attempts, defeated, best_damage)
       VALUES ($1, $2::date, 0, FALSE, 0)
       ON CONFLICT (member_id, boss_date) DO NOTHING`,
      [req.member.id, day]
    );
    const dayRow = await client.query(
      `SELECT * FROM pet_boss_daily WHERE member_id = $1 AND boss_date = $2::date FOR UPDATE`,
      [req.member.id, day]
    );
    let attempts = Number(dayRow.rows[0].attempts) || 0;
    let defeated = !!dayRow.rows[0].defeated;
    if (attempts >= 3) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "No boss attempts left today (3/3)." });
    }

    const petRes = await client.query(
      `SELECT * FROM owned_pets WHERE id = $1 AND member_id = $2 FOR UPDATE`,
      [ownedId, req.member.id]
    );
    if (!petRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    const pet = petRes.rows[0];
    if (Number(pet.energy) < 18) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Need at least 18 energy for Daily Boss." });
    }

    const lv = Number(pet.level) || 1;
    const my = {
      name: pet.name,
      level: lv,
      hp: Number(pet.hp) + lv * 8,
      maxHp: Number(pet.hp) + lv * 8,
      atk: Number(pet.atk) + lv * 2,
      def: Number(pet.def) + Math.floor(lv * 0.8),
      spd: Number(pet.spd) + Math.floor(lv * 0.5)
    };
    const myEl = pet.element || "Earth";
    const en = {
      name: boss.name,
      hp: Math.max(80, Math.round(my.hp * boss.mult * 1.05)),
      atk: Math.max(12, Math.round(my.atk * boss.mult * 0.92)),
      def: Math.max(8, Math.round(my.def * boss.mult * 0.9)),
      spd: Math.max(6, Math.round(my.spd * 0.95)),
      maxHp: Math.max(80, Math.round(my.hp * boss.mult * 1.05))
    };
    const enEl = boss.element;
    const sim = (typeof simulateBattleWithSkills === "function")
      ? simulateBattleWithSkills({ ...my, name: pet.name }, { ...en, name: boss.name }, myEl, enEl)
      : simulateBattle({ ...my, name: pet.name }, { ...en, name: boss.name }, myEl, enEl);

    const win = !!sim.win;
    attempts += 1;
    const damage = Math.max(0, (sim.enMax || en.hp) - (sim.rounds && sim.rounds.length ? Number(sim.rounds[sim.rounds.length - 1].enHp) : 0));
    const best = Math.max(Number(dayRow.rows[0].best_damage) || 0, damage);
    if (win) defeated = true;

    let reward = win ? boss.reward : Math.round(boss.reward * 0.15 * 100) / 100;
    const rel = elementRelation(myEl, enEl);
    if (win && rel.key === "advantage") reward = Math.round(reward * 1.2 * 100) / 100;

    await client.query(
      `UPDATE owned_pets SET energy = GREATEST(0, energy - 18),
        exp = COALESCE(exp, 0) + $1 WHERE id = $2`,
      [win ? boss.exp : Math.floor(boss.exp * 0.25), ownedId]
    );
    const petAfter = await applyLevelAndRarity(client, ownedId, req.member.id);
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'PET_BOSS',$3)`,
      [req.member.id, reward, makeReference("AMT-BOSS")]
    );
    await client.query(
      `UPDATE pet_boss_daily SET attempts = $1, defeated = $2, best_damage = $3
       WHERE member_id = $4 AND boss_date = $5::date`,
      [attempts, defeated, best, req.member.id, day]
    );
    let drops = [];
    try {
      await ensureGearTables();
      await addMaterial(client, req.member.id, "upgrade_core", win ? 2 : 1);
      drops.push(win ? "Upgrade Core x2" : "Upgrade Core x1");
      if (win && Math.random() < 0.45) {
        const g = ["gem_atk_2", "gem_hp_2", "gem_def_2"][Math.floor(Math.random() * 3)];
        await addMaterial(client, req.member.id, g, 1);
        drops.push((getMaterial(g) || {}).name || g);
      }
    } catch (e) {}
    await client.query("COMMIT");

    res.json({
      ok: true,
      mode: "boss",
      drops,
      result: win ? "WIN" : "LOSS",
      tierLabel: "Daily Boss",
      opponent: boss.name,
      opponentElement: enEl,
      petName: pet.name,
      petElement: myEl,
      elementRelation: rel.key,
      elementLabel: rel.label,
      reward,
      damage,
      attemptsLeft: Math.max(0, 3 - attempts),
      defeated,
      winStreak: null,
      myMaxHp: sim.myMax || my.hp,
      enMaxHp: sim.enMax || en.hp,
      rounds: sim.rounds || [],
      petLevel: petAfter && petAfter.level,
      milestones: (petAfter && petAfter._milestones) || [],
      chargeBonus: win ? "Boss defeated!" : ("Attempts left: " + Math.max(0, 3 - attempts))
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("BOSS FIGHT:", e);
    res.status(500).json({ ok: false, error: "Boss fight failed." });
  } finally {
    client.release();
  }
});

app.post("/api/pets/squad/battle", requireAuth, async (req, res) => {
  const size = Number(req.body?.size) === 4 ? 4 : 3;
  const tierKey = pickTier(req.body?.tier, 15);
  const tier = BATTLE_TIERS[tierKey] || BATTLE_TIERS.hunter;

  const client = await pool.connect();
  try {
    await ensurePetTables();
    await ensureSquadTables();
    await ensureArenaTables();

    const squadRows = await client.query(
      `SELECT s.slot, p.*
       FROM pet_squads s
       JOIN owned_pets p ON p.id = s.owned_pet_id AND p.member_id = s.member_id
       WHERE s.member_id = $1
       ORDER BY s.slot ASC
       LIMIT $2`,
      [req.member.id, size]
    );
    if (squadRows.rows.length < size) {
      return res.status(400).json({
        ok: false,
        error: "Set a full " + size + "v" + size + " squad first (Market → Squad)."
      });
    }

    // Energy: each pet needs 10
    for (const p of squadRows.rows) {
      if (Number(p.energy) < 10) {
        return res.status(400).json({
          ok: false,
          error: p.name + " needs at least 10 energy."
        });
      }
    }

    const spent = await spendBattleCharge(client, req.member.id);
    if (spent.error) {
      return res.status(400).json({ ok: false, error: spent.error, charges: spent.charges });
    }
    const day = spent.day;

    const myTeam = squadRows.rows.map(combatStatsFromOwned);
    // Build enemy team scaled
    const enemyTeam = [];
    for (let i = 0; i < size; i++) {
      const ref = myTeam[i];
      let foePool = AMT_PETS.filter(p => p.name !== ref.name);
      if (!foePool.length) foePool = AMT_PETS.slice();
      const wild = foePool[Math.floor(Math.random() * foePool.length)] || AMT_PETS[0];
      const mult = tier.mult * (0.96 + Math.random() * 0.1);
      enemyTeam.push({
        name: tier.label + " " + wild.name,
        element: wild.element || "Earth",
        image: wild.image || null,
        level: ref.level,
        hp: Math.max(30, Math.round(ref.hp * mult)),
        maxHp: Math.max(30, Math.round(ref.hp * mult)),
        atk: Math.max(8, Math.round(ref.atk * mult * 0.95)),
        def: Math.max(5, Math.round(ref.def * mult * 0.9)),
        spd: Math.max(5, Math.round(ref.spd * (0.9 + Math.random() * 0.25)))
      });
    }

    // Sequential 1v1 until one team wiped
    const allRounds = [];
    let myIdx = 0;
    let enIdx = 0;
    let match = 0;
    const myAlive = myTeam.map(p => ({ ...p, hp: p.hp, maxHp: p.maxHp || p.hp }));
    const enAlive = enemyTeam.map(p => ({ ...p, hp: p.hp, maxHp: p.maxHp || p.hp }));

    while (myIdx < size && enIdx < size && match < size * 2) {
      match += 1;
      const a = myAlive[myIdx];
      const b = enAlive[enIdx];
      const sim = simulateBattleWithSkills(a, b, a.element, b.element);
      allRounds.push({
        match,
        myPet: a.name,
        enemyPet: b.name,
        result: sim.win ? "WIN" : "LOSS",
        rounds: sim.rounds
      });
      if (sim.win) {
        enIdx += 1;
        // carry some HP for winner optional - full reset next fight for simplicity
      } else {
        myIdx += 1;
      }
    }

    const teamWin = enIdx >= size && myIdx < size;
    const baseReward = size === 4 ? 2.5 : 1.8;
    const reward = teamWin
      ? Math.round((baseReward * tier.mult * (0.9 + Math.random() * 0.3)) * 100) / 100
      : 0.15;

    // Deduct energy + exp
    for (const p of squadRows.rows) {
      await client.query(
        `UPDATE owned_pets SET energy = GREATEST(0, energy - 10),
          exp = COALESCE(exp, 0) + $1 WHERE id = $2`,
        [teamWin ? 30 : 10, p.id]
      );
      await applyLevelAndRarity(client, p.id, req.member.id);
    }

    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference)
       VALUES ($1,$2,'PET_SQUAD',$3)`,
      [req.member.id, reward, makeReference("AMT-SQUAD")]
    );
    const chargeInfo = await applyBattleWinCharges(client, req.member.id, day, teamWin);
    for (const p of squadRows.rows) {
      try { await applyBattleRep(client, req.member.id, p.id, teamWin, "squad", false); } catch (e) {}
    }

    // Flatten first match rounds for existing arena UI + include team summary
    const first = allRounds[0] || { rounds: [] };
    res.json({
      ok: true,
      result: teamWin ? "WIN" : "LOSS",
      mode: "squad",
      size,
      tier: tierKey,
      tierLabel: size + "v" + size + " " + tier.label,
      reward,
      matches: allRounds,
      opponent: enAlive.map(e => e.name).join(" / "),
      opponentElement: enAlive[0] && enAlive[0].element,
      opponentImage: enAlive[0] && enAlive[0].image,
      petName: myAlive.map(m => m.name).join(" / "),
      myMaxHp: first.rounds && first.rounds.length ? (allRounds[0].rounds[0] ? myAlive[0].maxHp : 100) : myAlive[0].maxHp,
      enMaxHp: enAlive[0].maxHp,
      rounds: allRounds.length ? allRounds[allRounds.length - 1].rounds : [],
      teamSummary: allRounds.map(m => m.myPet + (m.result === "WIN" ? " ✓" : " ✗") + " vs " + m.enemyPet).join(" · "),
      chargesLeft: chargeInfo.charges,
      winStreak: chargeInfo.streak,
      chargeBonus: chargeInfo.message || ""
    });
  } catch (e) {
    console.error("SQUAD BATTLE:", e);
    res.status(500).json({ ok: false, error: "Squad battle failed." });
  } finally {
    client.release();
  }
});


app.get("/api/pets/:ownedId/history", requireAuth, async (req, res) => {
  const ownedId = Number(req.params.ownedId);
  if (!Number.isInteger(ownedId)) {
    return res.status(400).json({ ok: false, error: "Invalid pet id." });
  }
  try {
    await ensurePetTables();
    const pet = await pool.query(
      `SELECT id, name, rep, wins, losses, origin, level, member_id FROM owned_pets WHERE id = $1`,
      [ownedId]
    );
    if (!pet.rows.length) {
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    const hist = await pool.query(
      `SELECT h.*, mf.username AS from_user, mt.username AS to_user
       FROM pet_ownership_history h
       LEFT JOIN members mf ON mf.id = h.from_member_id
       LEFT JOIN members mt ON mt.id = h.to_member_id
       WHERE h.owned_pet_id = $1
       ORDER BY h.created_at ASC
       LIMIT 50`,
      [ownedId]
    );
    res.json({
      ok: true,
      pet: pet.rows[0],
      repBadge: repBadge(pet.rows[0].rep),
      history: hist.rows
    });
  } catch (e) {
    console.error("HISTORY:", e);
    res.status(500).json({ ok: false, error: "History unavailable." });
  }
});

app.get("/api/owner/rep", requireAuth, async (req, res) => {
  try {
    await ensurePetTables();
    await ensureOwnerRep(null, req.member.id);
    const r = await pool.query(`SELECT * FROM owner_rep WHERE member_id = $1`, [req.member.id]);
    const row = r.rows[0] || { rep: 0, wins: 0, losses: 0 };
    res.json({
      ok: true,
      rep: row.rep,
      wins: row.wins,
      losses: row.losses,
      badge: repBadge(row.rep)
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Rep unavailable." });
  }
});


/* ========== PET GRIND MAP ========== */
app.get("/api/pets/grind/map", requireAuth, async (req, res) => {
  try {
    await ensureGrindTables();
    const active = await pool.query(
      `SELECT g.*, op.name AS pet_name, op.level AS pet_level
       FROM pet_grinds g
       LEFT JOIN owned_pets op ON op.id = g.owned_pet_id
       WHERE g.member_id = $1 AND g.status = 'active'
       ORDER BY g.ends_at ASC`,
      [req.member.id]
    );
    const now = Date.now();
    const zones = GRIND_ZONES.map(z => ({
      id: z.id,
      name: z.name,
      emoji: z.emoji,
      minLevel: z.minLevel,
      expPerHour: z.expPerHour,
      energyCostPerHour: z.energyCostPerHour,
      amtPerHour: z.amtPerHour
    }));
    res.json({
      ok: true,
      zones,
      durations: GRIND_DURATIONS,
      maxActive: 3,
      active: active.rows.map(r => ({
        id: Number(r.id),
        ownedPetId: Number(r.owned_pet_id),
        petName: r.pet_name || ("Pet #" + r.owned_pet_id),
        petLevel: Number(r.pet_level || 1),
        zoneId: Number(r.zone_id),
        zoneName: (GRIND_ZONES.find(z => z.id === Number(r.zone_id)) || {}).name || ("Zone " + r.zone_id),
        hours: Number(r.hours),
        startedAt: r.started_at,
        endsAt: r.ends_at,
        ready: new Date(r.ends_at).getTime() <= now,
        msLeft: Math.max(0, new Date(r.ends_at).getTime() - now)
      }))
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Map load failed." });
  }
});

app.post("/api/pets/grind/deploy", requireAuth, async (req, res) => {
  const ownedPetId = Number(req.body?.ownedPetId);
  const zoneId = Number(req.body?.zoneId);
  const hours = Number(req.body?.hours);
  const zone = GRIND_ZONES.find(z => z.id === zoneId);
  const dur = GRIND_DURATIONS.find(d => d.hours === hours);
  if (!ownedPetId || !zone || !dur) {
    return res.status(400).json({ ok: false, error: "Pick pet, zone, and duration (1/4/8/24h)." });
  }
  const client = await pool.connect();
  try {
    await ensureGrindTables();
    await client.query("BEGIN");
    const petR = await client.query(
      `SELECT * FROM owned_pets WHERE id = $1 AND member_id = $2 FOR UPDATE`,
      [ownedPetId, req.member.id]
    );
    if (!petR.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    const pet = petR.rows[0];
    const level = Number(pet.level || 1);
    if (level < zone.minLevel) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Need pet level " + zone.minLevel + " for " + zone.name + "." });
    }
    const busy = await client.query(
      `SELECT id FROM pet_grinds WHERE owned_pet_id = $1 AND status = 'active' LIMIT 1`,
      [ownedPetId]
    );
    if (busy.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "This pet is already grinding." });
    }
    const countR = await client.query(
      `SELECT COUNT(*)::int AS c FROM pet_grinds WHERE member_id = $1 AND status = 'active'`,
      [req.member.id]
    );
    if (Number(countR.rows[0].c) >= 3) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Max 3 pets grinding at once." });
    }
    const energyCost = Math.ceil(zone.energyCostPerHour * hours);
    const energy = Number(pet.energy ?? 100);
    if (energy < energyCost) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Need " + energyCost + " energy (have " + energy + "). Buy Energy Pack or wait." });
    }
    await client.query(
      `UPDATE owned_pets SET energy = GREATEST(0, energy - $1) WHERE id = $2`,
      [energyCost, ownedPetId]
    );
    const ends = new Date(Date.now() + hours * 3600 * 1000);
    const ins = await client.query(
      `INSERT INTO pet_grinds (member_id, owned_pet_id, zone_id, hours, energy_cost, ends_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,'active') RETURNING id, started_at, ends_at`,
      [req.member.id, ownedPetId, zoneId, hours, energyCost, ends.toISOString()]
    );
    await client.query("COMMIT");
    res.json({
      ok: true,
      message: (pet.name || "Pet") + " deployed to " + zone.name + " for " + hours + "h (−" + energyCost + " energy)",
      grindId: Number(ins.rows[0].id),
      endsAt: ins.rows[0].ends_at,
      energyCost
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ ok: false, error: e.message || "Deploy failed." });
  } finally {
    client.release();
  }
});

app.post("/api/pets/grind/claim", requireAuth, async (req, res) => {
  const grindId = Number(req.body?.grindId);
  if (!grindId) return res.status(400).json({ ok: false, error: "Missing grindId." });
  const client = await pool.connect();
  try {
    await ensureGrindTables();
    await client.query("BEGIN");
    const gR = await client.query(
      `SELECT * FROM pet_grinds WHERE id = $1 AND member_id = $2 AND status = 'active' FOR UPDATE`,
      [grindId, req.member.id]
    );
    if (!gR.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Grind not found or already claimed." });
    }
    const g = gR.rows[0];
    if (new Date(g.ends_at).getTime() > Date.now()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Still grinding — wait for timer." });
    }
    const zone = GRIND_ZONES.find(z => z.id === Number(g.zone_id)) || GRIND_ZONES[0];
    const hours = Number(g.hours) || 1;
    const petR = await client.query(
      `SELECT * FROM owned_pets WHERE id = $1 AND member_id = $2 FOR UPDATE`,
      [g.owned_pet_id, req.member.id]
    );
    if (!petR.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet missing." });
    }
    const pet = petR.rows[0];
    let expGain = Math.round(zone.expPerHour * hours);
    const amtGain = Math.round(zone.amtPerHour * hours * 1000) / 1000;
    const loot = [];
    // food rolls (up to hours times, capped)
    let foodQty = 0;
    for (let i = 0; i < hours; i++) {
      if (Math.random() < zone.foodChance) foodQty++;
    }
    if (foodQty > 0) {
      await addMaterial(client, req.member.id, "pet_food", foodQty);
      loot.push(foodQty + "x Pet Food");
    }
    let waterQty = 0;
    for (let i = 0; i < hours; i++) {
      if (Math.random() < (zone.foodChance || 0.35) * 0.9) waterQty++;
    }
    if (waterQty > 0) {
      await addMaterial(client, req.member.id, "water_crystal", waterQty);
      loot.push(waterQty + "x Water Crystal");
    }
    let mineralQty = 0;
    for (let i = 0; i < hours; i++) {
      if (Math.random() < 0.22) mineralQty++;
    }
    if (mineralQty > 0) {
      await addMaterial(client, req.member.id, "mineral_ore", mineralQty);
      loot.push(mineralQty + "x Mineral Ore");
    }
    let shardQty = 0;
    for (let i = 0; i < hours; i++) {
      if (Math.random() < 0.12) shardQty++;
    }
    if (shardQty > 0) {
      await addMaterial(client, req.member.id, "energy_shard", shardQty);
      loot.push(shardQty + "x Energy Shard");
    }
    // grinding also drains needs a bit
    await client.query(
      `UPDATE owned_pets SET
        hunger = GREATEST(0, COALESCE(hunger,100) - $1),
        thirst = GREATEST(0, COALESCE(thirst,100) - $2),
        last_needs_at = NOW()
       WHERE id = $3`,
      [Math.min(40, hours * 3), Math.min(45, hours * 4), pet.id]
    );
    let cores = 0;
    for (let i = 0; i < hours; i++) {
      if (Math.random() < zone.coreChance) cores++;
    }
    if (cores > 0) {
      await addMaterial(client, req.member.id, "upgrade_core", cores);
      loot.push(cores + "x Upgrade Core");
    }
    let gems = 0;
    const gemPool = ["gem_atk_1", "gem_hp_1", "gem_def_1"];
    const gotGems = [];
    for (let i = 0; i < hours; i++) {
      if (Math.random() < zone.gemChance) {
        gems++;
        const gid = gemPool[Math.floor(Math.random() * gemPool.length)];
        await addMaterial(client, req.member.id, gid, 1);
        gotGems.push(gid);
      }
    }
    if (gems > 0) loot.push(gems + "x Gem");
    // apply EXP / level
    let level = Number(pet.level || 1);
    let exp = Number(pet.exp || 0) + expGain;
    const need = (lv) => 40 + lv * 25;
    while (exp >= need(level) && level < 100) {
      exp -= need(level);
      level += 1;
    }
    await client.query(
      `UPDATE owned_pets SET level = $1, exp = $2 WHERE id = $3`,
      [level, exp, pet.id]
    );
    if (amtGain > 0) {
      await client.query(
        `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'GRIND_LOOT',$3)`,
        [req.member.id, amtGain, "GRIND-" + grindId]
      );
      loot.push("+" + amtGain + " AMT");
    }
    const reward = { expGain, level, amtGain, loot };
    await client.query(
      `UPDATE pet_grinds SET status = 'claimed', claimed_at = NOW(), reward_json = $1 WHERE id = $2`,
      [JSON.stringify(reward), grindId]
    );
    await client.query("COMMIT");
    res.json({
      ok: true,
      message: "Claimed from " + zone.name + " · +" + expGain + " EXP" + (loot.length ? " · " + loot.join(", ") : ""),
      expGain,
      level,
      amtGain,
      loot
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ ok: false, error: e.message || "Claim failed." });
  } finally {
    client.release();
  }
});

app.get("/api/pets/story", requireAuth, async (req, res) => {
  try {
    await ensurePetTables();
    let prog = await pool.query(
      `SELECT * FROM pet_story_progress WHERE member_id = $1`,
      [req.member.id]
    );
    if (!prog.rows.length) {
      await pool.query(
        `INSERT INTO pet_story_progress (member_id, chapter, clears_today, total_clears)
         VALUES ($1, 1, 0, 0)`,
        [req.member.id]
      );
      prog = await pool.query(
        `SELECT * FROM pet_story_progress WHERE member_id = $1`,
        [req.member.id]
      );
    }
    const p = prog.rows[0];
    const today = new Date().toISOString().slice(0, 10);
    let clearsToday = Number(p.clears_today || 0);
    if (String(p.clear_date || "") !== today) clearsToday = 0;
    res.json({
      ok: true,
      chapter: Number(p.chapter) || 1,
      clearsToday,
      clearsLeft: Math.max(0, 3 - clearsToday),
      totalClears: Number(p.total_clears || 0),
      chapters: STORY_CHAPTERS.map(c => ({
        id: c.id,
        name: c.name,
        unlocked: c.id <= (Number(p.chapter) || 1),
        exp: c.exp,
        reward: c.reward
      }))
    });
  } catch (e) {
    console.error("STORY GET:", e);
    res.status(500).json({ ok: false, error: "Story unavailable." });
  }
});

app.post("/api/pets/story/play", requireAuth, async (req, res) => {
  const ownedId = Number(req.body?.ownedPetId);
  const chapterId = Number(req.body?.chapter) || 0;
  if (!Number.isInteger(ownedId)) {
    return res.status(400).json({ ok: false, error: "ownedPetId required." });
  }
  const client = await pool.connect();
  try {
    await ensurePetTables();
    const petRes = await client.query(
      `SELECT * FROM owned_pets WHERE id = $1 AND member_id = $2`,
      [ownedId, req.member.id]
    );
    if (!petRes.rows.length) {
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    const pet = petRes.rows[0];
    let prog = await client.query(
      `SELECT * FROM pet_story_progress WHERE member_id = $1 FOR UPDATE`,
      [req.member.id]
    );
    if (!prog.rows.length) {
      await client.query(
        `INSERT INTO pet_story_progress (member_id, chapter) VALUES ($1, 1)`,
        [req.member.id]
      );
      prog = await client.query(
        `SELECT * FROM pet_story_progress WHERE member_id = $1 FOR UPDATE`,
        [req.member.id]
      );
    }
    const pr = prog.rows[0];
    const maxChapter = Number(pr.chapter) || 1;
    const ch = STORY_CHAPTERS.find(c => c.id === (chapterId || maxChapter)) ||
      STORY_CHAPTERS[Math.min(maxChapter, STORY_CHAPTERS.length) - 1];
    if (ch.id > maxChapter) {
      return res.status(400).json({ ok: false, error: "Chapter locked. Clear previous first." });
    }
    const today = new Date().toISOString().slice(0, 10);
    let clearsToday = Number(pr.clears_today || 0);
    if (String(pr.clear_date || "") !== today) clearsToday = 0;
    if (clearsToday >= 3) {
      return res.status(400).json({
        ok: false,
        error: "Daily story limit (3). Come back tomorrow."
      });
    }
    if (Number(pet.energy) < ch.energy) {
      return res.status(400).json({
        ok: false,
        error: "Need " + ch.energy + " energy for this chapter."
      });
    }

    const lv = Number(pet.level) || 1;
    const my = {
      name: pet.name,
      level: lv,
      hp: Number(pet.hp) + lv * 8,
      maxHp: Number(pet.hp) + lv * 8,
      atk: Number(pet.atk) + lv * 2,
      def: Number(pet.def) + Math.floor(lv * 0.8),
      spd: Number(pet.spd) + Math.floor(lv * 0.5)
    };
    // Story enemies scale soft — friendlier for low level
    const mult = ch.mult * (lv < 15 ? 0.85 : lv > 30 ? 1.05 : 0.95);
    let foePool = AMT_PETS.slice();
    const wild = foePool[Math.floor(Math.random() * foePool.length)] || AMT_PETS[0];
    const en = {
      name: ch.name + " Guardian",
      level: Math.max(1, Math.round(lv * mult)),
      hp: Math.max(25, Math.round(my.hp * mult)),
      maxHp: Math.max(25, Math.round(my.hp * mult)),
      atk: Math.max(6, Math.round(my.atk * mult * 0.9)),
      def: Math.max(4, Math.round(my.def * mult * 0.85)),
      spd: Math.max(4, Math.round(my.spd * 0.95))
    };
    const sim = (typeof simulateBattleWithSkills === "function")
      ? simulateBattleWithSkills(my, en, pet.element, wild.element || "Earth")
      : simulateBattle(my, en, pet.element, wild.element || "Earth");
    const win = sim.win;

    // Exp: boost for low level, damp for high
    let expGain = ch.exp;
    if (lv <= 10) expGain = Math.round(ch.exp * 1.5);
    else if (lv <= 20) expGain = Math.round(ch.exp * 1.2);
    else if (lv >= 30) expGain = Math.round(ch.exp * 0.5);
    if (!win) expGain = Math.round(expGain * 0.25);

    const reward = win ? ch.reward : 0.05;
    const underdog = win && en.level >= lv + 8;

    await client.query(
      `UPDATE owned_pets SET energy = GREATEST(0, energy - $1),
        exp = COALESCE(exp, 0) + $2 WHERE id = $3`,
      [ch.energy, expGain, ownedId]
    );
    const petAfter = await applyLevelAndRarity(client, ownedId, req.member.id);
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference)
       VALUES ($1,$2,'PET_STORY',$3)`,
      [req.member.id, reward, makeReference("AMT-STORY")]
    );
    await applyBattleRep(client, req.member.id, ownedId, win, "story", underdog);

    let newChapter = maxChapter;
    if (win && ch.id >= maxChapter && maxChapter < STORY_CHAPTERS.length) {
      newChapter = maxChapter + 1;
    }
    await client.query(
      `UPDATE pet_story_progress SET
        chapter = $1,
        clears_today = $2,
        clear_date = $3::date,
        total_clears = total_clears + 1
       WHERE member_id = $4`,
      [newChapter, clearsToday + 1, today, req.member.id]
    );

    res.json({
      ok: true,
      result: win ? "WIN" : "LOSS",
      mode: "story",
      tierLabel: "Story · " + ch.name,
      chapter: ch.id,
      chapterName: ch.name,
      reward,
      expGain,
      underdog,
      opponent: en.name,
      opponentElement: wild.element,
      opponentImage: wild.image,
      petName: pet.name,
      petElement: pet.element,
      petImage: pet.image,
      myMaxHp: sim.myMax,
      enMaxHp: sim.enMax,
      rounds: sim.rounds,
      petLevel: petAfter && petAfter.level,
      milestones: (petAfter && petAfter._milestones) || [],
      nextChapter: newChapter,
      clearsLeft: Math.max(0, 3 - (clearsToday + 1))
    });
  } catch (e) {
    console.error("STORY PLAY:", e);
    res.status(500).json({ ok: false, error: "Story battle failed." });
  } finally {
    client.release();
  }
});


app.get("/api/gear/shop", requireAuth, async (req, res) => {
  res.json({ ok: true, gear: AMT_GEAR });
});

app.get("/api/gear/inventory", requireAuth, async (req, res) => {
  try {
    await ensureGearTables();
    const r = await pool.query(
      `SELECT gear_id, qty FROM pet_inventory WHERE member_id = $1 AND qty > 0`,
      [req.member.id]
    );
    // upgrades/gems currently on pets for this member
    const eq = await pool.query(
      `SELECT e.gear_id, e.slot, e.upgrade_level, e.gem1, e.gem2, p.name AS pet_name
       FROM pet_equipment e
       JOIN owned_pets p ON p.id = e.owned_pet_id
       WHERE p.member_id = $1`,
      [req.member.id]
    );
    const byGear = {};
    for (const row of eq.rows) {
      byGear[row.gear_id] = {
        upgrade_level: Number(row.upgrade_level) || 0,
        gem1: row.gem1,
        gem2: row.gem2,
        pet_name: row.pet_name,
        equipped: true
      };
    }
    const items = r.rows.map(row => {
      const g = getGearById(row.gear_id) || { id: row.gear_id, name: row.gear_id };
      const extra = byGear[row.gear_id] || {};
      return { ...g, qty: row.qty, ...extra };
    });
    const mr = await pool.query(
      `SELECT material_id, qty FROM member_materials WHERE member_id = $1 AND qty > 0`,
      [req.member.id]
    );
    const materials = mr.rows.map(row => {
      const m = getMaterial(row.material_id) || { id: row.material_id, name: row.material_id };
      return { ...m, qty: Number(row.qty) };
    });
    res.json({ ok: true, items, materials });
  } catch (e) {
    console.error("GEAR INV:", e);
    res.status(500).json({ ok: false, error: "Inventory failed." });
  }
});

app.post("/api/gear/buy", requireAuth, async (req, res) => {
  const gearId = String(req.body?.gearId || "").trim();
  const g = getGearById(gearId);
  if (!g) return res.status(404).json({ ok: false, error: "Gear not found." });
  const client = await pool.connect();
  try {
    await ensureGearTables();
    await client.query("BEGIN");
    const bal = await getBalance(req.member.id, client);
    if (bal < g.priceAmt) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Insufficient AMT." });
    }
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference)
       VALUES ($1,$2,'GEAR_BUY',$3)`,
      [req.member.id, -g.priceAmt, makeReference("AMT-GEAR")]
    );
    await client.query(
      `INSERT INTO pet_inventory (member_id, gear_id, qty)
       VALUES ($1,$2,1)
       ON CONFLICT (member_id, gear_id)
       DO UPDATE SET qty = pet_inventory.qty + 1`,
      [req.member.id, gearId]
    );
    await client.query("COMMIT");
    const newBal = await getBalance(req.member.id);
    res.json({ ok: true, gear: g, balance: newBal, message: g.name + " added to backpack." });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("GEAR BUY:", e);
    res.status(500).json({ ok: false, error: "Purchase failed." });
  } finally {
    client.release();
  }
});

app.get("/api/pets/:ownedId/equipment", requireAuth, async (req, res) => {
  const ownedId = Number(req.params.ownedId);
  if (!Number.isFinite(ownedId) || ownedId < 1) {
    return res.status(400).json({ ok: false, error: "Invalid pet." });
  }
  try {
    await ensureGearTables();
    const pet = await pool.query(
      `SELECT id, name, member_id FROM owned_pets WHERE id = $1 AND member_id = $2`,
      [ownedId, req.member.id]
    );
    if (!pet.rows.length) return res.status(404).json({ ok: false, error: "Pet not found." });
    const map = await getPetEquipmentMap(null, ownedId);
    const bonuses = sumGearBonuses(map);
    const slots = ["weapon", "shield", "head", "body", "boots", "accessory"].map(slot => {
      const entry = map[slot];
      const gid = entry && (typeof entry === "string" ? entry : entry.gear_id);
      const g = gid ? getGearById(gid) : null;
      return {
        slot,
        gear: g,
        upgrade_level: entry && typeof entry === "object" ? entry.upgrade_level : 0,
        gem1: entry && typeof entry === "object" ? entry.gem1 : null,
        gem2: entry && typeof entry === "object" ? entry.gem2 : null
      };
    });
    res.json({ ok: true, slots, bonuses });
  } catch (e) {
    console.error("GEAR GET:", e);
    res.status(500).json({ ok: false, error: "Equipment failed." });
  }
});

app.post("/api/gear/equip", requireAuth, async (req, res) => {
  const ownedId = Number(req.body?.ownedPetId);
  const gearId = String(req.body?.gearId || "").trim();
  const g = getGearById(gearId);
  if (!Number.isFinite(ownedId) || ownedId < 1 || !g) {
    return res.status(400).json({ ok: false, error: "ownedPetId and gearId required." });
  }
  const client = await pool.connect();
  try {
    await ensureGearTables();
    const pet = await client.query(
      `SELECT id FROM owned_pets WHERE id = $1 AND member_id = $2`,
      [ownedId, req.member.id]
    );
    if (!pet.rows.length) {
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    const inv = await client.query(
      `SELECT qty FROM pet_inventory WHERE member_id = $1 AND gear_id = $2`,
      [req.member.id, gearId]
    );
    if (!inv.rows.length || Number(inv.rows[0].qty) < 1) {
      return res.status(400).json({ ok: false, error: "Item not in backpack." });
    }
    // Unequip previous in slot back stays in inventory (shared pool)
    await client.query(
      `INSERT INTO pet_equipment (owned_pet_id, slot, gear_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (owned_pet_id, slot)
       DO UPDATE SET gear_id = EXCLUDED.gear_id, updated_at = NOW()`,
      [ownedId, g.slot, gearId]
    );
    const map = await getPetEquipmentMap(client, ownedId);
    res.json({
      ok: true,
      message: g.name + " equipped on " + g.slot,
      slots: map,
      bonuses: sumGearBonuses(map)
    });
  } catch (e) {
    console.error("GEAR EQUIP:", e);
    res.status(500).json({ ok: false, error: "Equip failed." });
  } finally {
    client.release();
  }
});

app.post("/api/gear/unequip", requireAuth, async (req, res) => {
  const ownedId = Number(req.body?.ownedPetId);
  const slot = String(req.body?.slot || "").trim();
  if (!Number.isInteger(ownedId) || !slot) {
    return res.status(400).json({ ok: false, error: "ownedPetId and slot required." });
  }
  try {
    await ensureGearTables();
    await pool.query(
      `DELETE FROM pet_equipment WHERE owned_pet_id = $1 AND slot = $2
       AND owned_pet_id IN (SELECT id FROM owned_pets WHERE member_id = $3)`,
      [ownedId, slot, req.member.id]
    );
    const map = await getPetEquipmentMap(null, ownedId);
    res.json({ ok: true, message: "Unequipped " + slot, bonuses: sumGearBonuses(map) });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Unequip failed." });
  }
});

/* ---- Materials / upgrade / gems ---- */
app.get("/api/gear/materials", requireAuth, async (req, res) => {
  try {
    await ensureGearTables();
    const r = await pool.query(
      `SELECT material_id, qty FROM member_materials WHERE member_id = $1 AND qty > 0`,
      [req.member.id]
    );
    const list = r.rows.map(row => {
      const m = getMaterial(row.material_id) || { id: row.material_id, name: row.material_id };
      return { ...m, qty: Number(row.qty) };
    });
    res.json({
      ok: true,
      materials: list,
      catalog: Object.values(AMT_MATERIALS)
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Materials load failed." });
  }
});

app.post("/api/gear/buy-material", requireAuth, async (req, res) => {
  const materialId = String(req.body?.materialId || "");
  const qty = Math.max(1, Math.min(50, Number(req.body?.qty) || 1));
  const m = getMaterial(materialId);
  if (!m) return res.status(400).json({ ok: false, error: "Unknown material." });
  const cost = Math.round(m.priceAmt * qty * 100) / 100;
  const client = await pool.connect();
  try {
    await ensureGearTables();
    await client.query("BEGIN");
    const bal = await getBalance(req.member.id, client);
    if (bal < cost) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Need " + cost + " AMT." });
    }
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'GEAR_MAT',$3)`,
      [req.member.id, -cost, makeReference("AMT-MAT")]
    );
    await addMaterial(client, req.member.id, materialId, qty);
    await client.query("COMMIT");
    res.json({ ok: true, materialId, qty, cost, message: "Bought " + qty + "x " + m.name });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ ok: false, error: e.message || "Buy failed." });
  } finally {
    client.release();
  }
});


/** Apply core/gem directly to a bag gear piece (auto-equip on first pet if needed) */
app.post("/api/gear/apply-to-item", requireAuth, async (req, res) => {
  const materialId = String(req.body?.materialId || "");
  const gearId = String(req.body?.gearId || "").trim();
  const m = getMaterial(materialId);
  const g = getGearById(gearId);
  if (!m) return res.status(400).json({ ok: false, error: "Unknown material." });
  if (!g) return res.status(400).json({ ok: false, error: "Unknown gear." });

  const client = await pool.connect();
  try {
    await ensureGearTables();
    await ensurePetTables();
    await client.query("BEGIN");

    // Must own the gear
    const inv = await client.query(
      `SELECT qty FROM pet_inventory WHERE member_id = $1 AND gear_id = $2`,
      [req.member.id, gearId]
    );
    if (!inv.rows.length || Number(inv.rows[0].qty) < 1) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Item not in your bag." });
    }

    // Prefer pet from body, else first owned pet
    let ownedPetId = Number(req.body?.ownedPetId);
    let petName = "";
    if (Number.isFinite(ownedPetId)) {
      const one = await client.query(
        `SELECT id, name FROM owned_pets WHERE id = $1 AND member_id = $2`,
        [ownedPetId, req.member.id]
      );
      if (!one.rows.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, error: "Pet not found." });
      }
      petName = one.rows[0].name;
    } else {
      const pets = await client.query(
        `SELECT id, name FROM owned_pets WHERE member_id = $1 ORDER BY id ASC LIMIT 1`,
        [req.member.id]
      );
      if (!pets.rows.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, error: "Walang pet. Bumili muna ng pet, then equip gear." });
      }
      ownedPetId = Number(pets.rows[0].id);
      petName = pets.rows[0].name;
    }

    // Equip this gear on the pet slot
    await client.query(
      `INSERT INTO pet_equipment (owned_pet_id, slot, gear_id, upgrade_level)
       VALUES ($1, $2, $3, 0)
       ON CONFLICT (owned_pet_id, slot)
       DO UPDATE SET gear_id = EXCLUDED.gear_id, updated_at = NOW()`,
      [ownedPetId, g.slot, gearId]
    );

    const eq = await client.query(
      `SELECT * FROM pet_equipment WHERE owned_pet_id = $1 AND slot = $2 FOR UPDATE`,
      [ownedPetId, g.slot]
    );
    const row = eq.rows[0];

    if (materialId === "upgrade_core") {
      const up = Number(row.upgrade_level) || 0;
      if (up >= GEAR_MAX_UPGRADE) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, error: "Max +" + GEAR_MAX_UPGRADE + " na ang item." });
      }
      const coresNeed = Math.min(up + 1, 10);
      const fee = Math.round((0.2 + up * 0.12) * 100) / 100;
      await spendMaterial(client, req.member.id, "upgrade_core", coresNeed);
      const bal = await getBalance(req.member.id, client);
      if (bal < fee) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, error: "Need " + fee + " AMT fee." });
      }
      await client.query(
        `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'GEAR_UP',$3)`,
        [req.member.id, -fee, makeReference("AMT-UP")]
      );
      await client.query(
        `UPDATE pet_equipment SET upgrade_level = $1, updated_at = NOW()
         WHERE owned_pet_id = $2 AND slot = $3`,
        [up + 1, ownedPetId, g.slot]
      );
      await client.query("COMMIT");
      return res.json({
        ok: true,
        action: "upgrade",
        gearId,
        gearName: g.name,
        upgrade_level: up + 1,
        petName,
        message: g.name + " → +" + (up + 1) + " (on " + petName + ")"
      });
    }

    if (m.kind === "gem") {
      await spendMaterial(client, req.member.id, materialId, 1);
      let gemIndex = 1;
      let col = "gem1";
      if (row.gem1 && !row.gem2) { gemIndex = 2; col = "gem2"; }
      else if (row.gem1 && row.gem2) { gemIndex = 1; col = "gem1"; }
      const oldGem = row[col];
      if (oldGem) await addMaterial(client, req.member.id, oldGem, 1);
      await client.query(
        `UPDATE pet_equipment SET ${col} = $1, updated_at = NOW()
         WHERE owned_pet_id = $2 AND slot = $3`,
        [materialId, ownedPetId, g.slot]
      );
      await client.query("COMMIT");
      return res.json({
        ok: true,
        action: "socket",
        gearId,
        gearName: g.name,
        gemIndex,
        materialId,
        petName,
        message: m.name + " → " + g.name + " slot " + gemIndex
      });
    }

    await client.query("ROLLBACK");
    res.status(400).json({ ok: false, error: "Not a core or gem." });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(e.status || 500).json({ ok: false, error: e.message || "Apply failed." });
  } finally {
    client.release();
  }
});


app.post("/api/gear/upgrade", requireAuth, async (req, res) => {
  const ownedPetId = Number(req.body?.ownedPetId);
  const slot = String(req.body?.slot || "weapon");
  if (!Number.isFinite(ownedPetId)) {
    return res.status(400).json({ ok: false, error: "ownedPetId required." });
  }
  const client = await pool.connect();
  try {
    await ensureGearTables();
    await client.query("BEGIN");
    const own = await client.query(
      `SELECT id FROM owned_pets WHERE id = $1 AND member_id = $2`,
      [ownedPetId, req.member.id]
    );
    if (!own.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    const eq = await client.query(
      `SELECT * FROM pet_equipment WHERE owned_pet_id = $1 AND slot = $2 FOR UPDATE`,
      [ownedPetId, slot]
    );
    if (!eq.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "No item equipped in " + slot + "." });
    }
    const up = Number(eq.rows[0].upgrade_level) || 0;
    if (up >= GEAR_MAX_UPGRADE) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Max upgrade +" + GEAR_MAX_UPGRADE + "." });
    }
    const coresNeed = Math.min(up + 1, 10);
    const fee = Math.round((0.2 + up * 0.12) * 100) / 100;
    await spendMaterial(client, req.member.id, "upgrade_core", coresNeed);
    const bal = await getBalance(req.member.id, client);
    if (bal < fee) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Need " + fee + " AMT fee." });
    }
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'GEAR_UP',$3)`,
      [req.member.id, -fee, makeReference("AMT-UP")]
    );
    await client.query(
      `UPDATE pet_equipment SET upgrade_level = $1, updated_at = NOW()
       WHERE owned_pet_id = $2 AND slot = $3`,
      [up + 1, ownedPetId, slot]
    );
    await client.query("COMMIT");
    res.json({
      ok: true,
      slot,
      upgrade_level: up + 1,
      coresUsed: coresNeed,
      fee,
      message: slot + " upgraded to +" + (up + 1)
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(e.status || 500).json({ ok: false, error: e.message || "Upgrade failed." });
  } finally {
    client.release();
  }
});

app.post("/api/gear/socket", requireAuth, async (req, res) => {
  const ownedPetId = Number(req.body?.ownedPetId);
  const slot = String(req.body?.slot || "weapon");
  const gemIndex = Number(req.body?.gemIndex) === 2 ? 2 : 1;
  const materialId = String(req.body?.materialId || "");
  const m = getMaterial(materialId);
  if (!m || m.kind !== "gem") {
    return res.status(400).json({ ok: false, error: "Pick a gem material." });
  }
  const client = await pool.connect();
  try {
    await ensureGearTables();
    await client.query("BEGIN");
    const own = await client.query(
      `SELECT id FROM owned_pets WHERE id = $1 AND member_id = $2`,
      [ownedPetId, req.member.id]
    );
    if (!own.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    const eq = await client.query(
      `SELECT * FROM pet_equipment WHERE owned_pet_id = $1 AND slot = $2 FOR UPDATE`,
      [ownedPetId, slot]
    );
    if (!eq.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Equip an item in " + slot + " first." });
    }
    await spendMaterial(client, req.member.id, materialId, 1);
    const col = gemIndex === 2 ? "gem2" : "gem1";
    // return old gem to inventory if any
    const oldGem = eq.rows[0][col];
    if (oldGem) await addMaterial(client, req.member.id, oldGem, 1);
    await client.query(
      `UPDATE pet_equipment SET ${col} = $1, updated_at = NOW()
       WHERE owned_pet_id = $2 AND slot = $3`,
      [materialId, ownedPetId, slot]
    );
    await client.query("COMMIT");
    res.json({
      ok: true,
      slot,
      gemIndex,
      materialId,
      message: m.name + " socketed in " + slot + " slot " + gemIndex
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(e.status || 500).json({ ok: false, error: e.message || "Socket failed." });
  } finally {
    client.release();
  }
});



app.get("/api/pets/:petId", async (req, res) => {
  const reserved = ["owned", "eggs", "listings", "buy", "care", "train", "claim-session", "cancel-session", "boss", "breed", "hatch", "list", "battle", "arena", "skills", "squad", "story", "battle-charges"];
  if (reserved.includes(String(req.params.petId || "").toLowerCase())) {
    return res.status(404).json({ ok: false, error: "Not found." });
  }
  const pet = getPetById(req.params.petId);
  if (!pet) return res.status(404).json({ ok: false, error: "Pet not found." });
  res.json({ ok: true, pet });
});

/* =========================================================
PRIVATE PI TESTNET MARKETPLACE
========================================================= */

app.get(
  "/api/market/test-product",
  async (req, res) => {
    res.json({
      ok: true,

      product: {
        id:
          MARKET_TEST_PRODUCT_ID,

        name:
          "AMT Test Pet",

        description:
          "Private AMT Pi Testnet marketplace test item.",

        pricePi:
          MARKET_TEST_PRICE_PI,

        currency:
          "Pi",

        network:
          "Pi Mainnet",

        environment:
          "MAINNET"
      }
    });
  }
);

/* =========================================================
PI PAYMENT API
========================================================= */

async function piPaymentRequest(
  path,
  method = "GET",
  body = null
) {
  if (!PI_API_KEY) {
    throw new Error(
      "PI_API_KEY is not configured."
    );
  }

  const response =
    await fetch(
      `${PI_PAYMENT_API_BASE}${path}`,
      {
        method,

        headers: {
          Accept:
            "application/json",

          "Content-Type":
            "application/json",

          Authorization:
            `Key ${PI_API_KEY}`
        },

        body:
          body === null
            ? undefined
            : JSON.stringify(body)
      }
    );

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    const error =
      new Error(
        data?.error ||
        data?.message ||
        `Pi Payment API error ${response.status}`
      );

    error.status =
      response.status;

    throw error;
  }

  return data;
}

/* =========================================================
MARKETPLACE PAYMENT APPROVE
========================================================= */

app.post(
  "/api/market/payment/approve",
  requireAuth,
  async (req, res) => {
    try {
      const paymentId =
        String(
          req.body?.paymentId || ""
        ).trim();

      const productId =
        String(
          req.body?.productId || ""
        ).trim();

      const amount =
        Number(
          req.body?.amount
        );

      if (!paymentId) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Payment ID is required."
          });
      }

      const parsed = parsePetProductId(productId);
      let expectedAmount = null;
      let resolvedProductId = productId;

      if (parsed.kind === "pet") {
        const pet = getPetById(parsed.petId);
        if (!pet) {
          return res.status(400).json({
            ok: false,
            error: "Invalid pet product."
          });
        }
        expectedAmount = petPricePi(pet);
        resolvedProductId = "pet:" + pet.id;
      } else if (productId === MARKET_TEST_PRODUCT_ID) {
        expectedAmount = MARKET_TEST_PRICE_PI;
        resolvedProductId = MARKET_TEST_PRODUCT_ID;
      } else {
        return res.status(400).json({
          ok: false,
          error: "Invalid product. Use pet:<id> or test product."
        });
      }

      if (
        !Number.isFinite(amount) ||
        Math.abs(amount - expectedAmount) > 0.001
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid price. Expected " + expectedAmount + " PI, got " + amount
        });
      }

      console.log("MARKET APPROVE", {
        paymentId,
        productId: resolvedProductId,
        amount,
        expectedAmount,
        paymentApi: PI_PAYMENT_API_BASE
      });

      const payment =
        await piPaymentRequest(
          `/v2/payments/${encodeURIComponent(
            paymentId
          )}`,
          "GET"
        );

      if (
        Math.abs(Number(payment.amount) - expectedAmount) > 0.001
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Payment amount does not match. Pi=" +
            payment.amount +
            " expected=" +
            expectedAmount
        });
      }

      await piPaymentRequest(
        `/v2/payments/${encodeURIComponent(
          paymentId
        )}/approve`,
        "POST"
      );

      const saved =
        await pool.query(
          `
          INSERT INTO marketplace_payments
            (
              pi_payment_id,
              member_id,
              product_id,
              amount,
              status
            )
          VALUES
            (
              $1,
              $2,
              $3,
              $4,
              'APPROVED'
            )

          ON CONFLICT (
            pi_payment_id
          )

          DO UPDATE SET
            status = 'APPROVED'

          RETURNING *
          `,
          [
            paymentId,
            req.member.id,
            resolvedProductId,
            amount
          ]
        );

      res.json({
        ok: true,
        approved: true,
        payment: saved.rows[0],
        productId: resolvedProductId,
        amount: expectedAmount
      });

    } catch (error) {
      console.error(
        "MARKET APPROVE ERROR:",
        error
      );

      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,
          error:
            error.message ||
            "Unable to approve payment."
        });
    }
  }
);


/* =========================================================
OWNERSHIP CERTIFICATE
========================================================= */
app.get("/api/pets/owned/:id/certificate", requireAuth, async (req, res) => {
  try {
    await ensurePetTables();
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: "Invalid pet id." });
    }
    const r = await pool.query(
      `SELECT o.*, m.username AS owner_username
       FROM owned_pets o
       LEFT JOIN members m ON m.id = o.member_id
       WHERE o.id = $1 AND o.member_id = $2
       LIMIT 1`,
      [id, req.member.id]
    );
    if (!r.rows.length) {
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    const pet = r.rows[0];
    let cert = pet.certificate_id;
    if (!cert) {
      cert = makeCertificateId(pet.origin || "shop");
      await pool.query(
        `UPDATE owned_pets SET certificate_id = $1 WHERE id = $2 AND certificate_id IS NULL`,
        [cert, id]
      );
      pet.certificate_id = cert;
    }
    const mintedWithPi = String(pet.origin || "") === "pi_payment";
    res.json({
      ok: true,
      certificate: {
        certificateId: pet.certificate_id,
        ownedPetId: pet.id,
        petName: pet.name,
        petId: pet.pet_id,
        element: pet.element,
        rarity: pet.rarity,
        level: pet.level,
        ownerUsername: pet.owner_username || req.member.username || "Pioneer",
        origin: pet.origin || "shop",
        mintedWithPi,
        mintLabel: mintedWithPi ? "Minted with PI (Mainnet)" : "App ownership certificate",
        purchasedAt: pet.purchased_at,
        reputation: {
          rep: Number(pet.rep) || 0,
          wins: Number(pet.wins) || 0,
          losses: Number(pet.losses) || 0
        },
        network: mintedWithPi ? "Pi Mainnet" : "AMT App Ledger"
      }
    });
  } catch (e) {
    console.error("CERTIFICATE ERROR:", e);
    res.status(500).json({ ok: false, error: e.message || "Certificate failed." });
  }
});

/* =========================================================
MARKETPLACE PAYMENT COMPLETE
========================================================= */

app.post(
  "/api/market/payment/complete",
  requireAuth,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const paymentId =
        String(
          req.body?.paymentId || ""
        ).trim();

      if (!paymentId) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Payment ID is required."
          });
      }

      await client.query(
        "BEGIN"
      );

      const paymentResult =
        await client.query(
          `
          SELECT *
          FROM marketplace_payments
          WHERE
            pi_payment_id = $1
          LIMIT 1
          FOR UPDATE
          `,
          [paymentId]
        );

      if (
        !paymentResult.rows.length
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Marketplace payment not found."
          });
      }

      const payment =
        paymentResult.rows[0];

      if (
        Number(
          payment.member_id
        ) !==
        Number(
          req.member.id
        )
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(403)
          .json({
            ok: false,
            error:
              "Payment does not belong to this Pioneer."
          });
      }

      const prodOk =
        payment.product_id === MARKET_TEST_PRODUCT_ID ||
        String(payment.product_id || "").startsWith("pet:");
      if (!prodOk) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          error: "Invalid marketplace product."
        });
      }

      if (
        payment.status ===
        "COMPLETED"
      ) {
        await client.query(
          "COMMIT"
        );

        return res.json({
          ok: true,

          completed:
            true,

          alreadyCompleted:
            true,

          paymentId,

          productId:
            payment.product_id,

          network:
            "Pi Mainnet"
        });
      }

      const txid = String(
        req.body?.txid ||
        req.body?.txId ||
        ""
      ).trim();

      console.log("MARKET COMPLETE", {
        paymentId,
        txid: txid || "(empty)",
        productId: payment.product_id,
        paymentApi: PI_PAYMENT_API_BASE
      });

      // Pi Platform requires txid for server-side completion
      await piPaymentRequest(
        `/v2/payments/${encodeURIComponent(
          paymentId
        )}/complete`,
        "POST",
        txid ? { txid } : {}
      );

      await client.query(
        `
        UPDATE marketplace_payments
        SET
          status = 'COMPLETED',
          completed_at = NOW()
        WHERE id = $1
        `,
        [payment.id]
      );

      await client.query(
        `
        INSERT INTO marketplace_purchases
          (
            payment_id,
            member_id,
            product_id
          )
        VALUES
          (
            $1,
            $2,
            $3
          )
        ON CONFLICT DO NOTHING
        `,
        [
          payment.id,
          req.member.id,
          payment.product_id
        ]
      );

      let deliveredPet = null;
      const pParsed = parsePetProductId(payment.product_id);
      if (pParsed.kind === "pet") {
        await ensurePetTables();
        const pet = getPetById(pParsed.petId);
        if (pet) {
          const certId = makeCertificateId("pi_payment");
          const ins = await client.query(
            `INSERT INTO owned_pets
              (member_id, pet_id, name, element, rarity, hp, atk, def, spd, ability, image, origin, certificate_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pi_payment',$12)
             RETURNING *`,
            [
              req.member.id,
              pet.id,
              pet.name,
              pet.element,
              pet.rarity,
              pet.hp,
              pet.atk,
              pet.def,
              pet.spd,
              pet.ability || "",
              pet.image || "",
              certId
            ]
          );
          deliveredPet = ins.rows[0] || null;
        }
      }

      await client.query(
        "COMMIT"
      );

      res.json({
        ok: true,
        completed: true,
        paymentId,
        productId: payment.product_id,
        network: "Pi Mainnet",
        pet: deliveredPet
      });

    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "MARKET COMPLETE ERROR:",
        error
      );

      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,
          error:
            error.message ||
            "Unable to complete payment."
        });

    } finally {
      client.release();
    }
  }
);

/* =========================================================
PURCHASES
========================================================= */

app.get(
  "/api/purchases",
  requireAuth,
  async (req, res) => {
    const result =
      await pool.query(
        `
        SELECT

          mp.id,
          mp.product_id,
          mp.created_at,

          p.pi_payment_id,
          p.amount,
          p.status

        FROM marketplace_purchases mp

        JOIN marketplace_payments p
          ON p.id =
             mp.payment_id

        WHERE
          mp.member_id = $1

        ORDER BY
          mp.created_at DESC
        `,
        [req.member.id]
      );

    res.json({
      ok: true,

      purchases:
        result.rows
    });
  }
);

/* =========================================================
LEGACY / FRONTEND COMPATIBILITY ROUTES
========================================================= */

/* ---------------------------------------------------------
POST /api/users
--------------------------------------------------------- */

app.post(
  "/api/users",
  requireAuth,
  async (req, res) => {
    try {
      const balance =
        await getBalance(
          req.member.id
        );

      const staking =
        await getStakingSummary(
          req.member.id
        );

      res.json({
        ok: true,

        user: {
          id:
            req.member.id,

          uid:
            req.piUser.uid,

          username:
            req.member.username,

          kycStatus:
            req.member.kyc_status,

          profileImage:
            req.member
              .profile_image || null
        },

        wallet: {
          walletStatus:
            req.wallet
              .wallet_status,

          walletAddress:
            req.wallet
              .wallet_address,

          isBlockchainWallet:
            false
        },

        /*
         * Added without changing the old wallet object.
         */
        piWalletAddress:
          req.piUser.walletAddress ||
          null,

        balance,

        availableBalance:
          balance,

        stakedBalance:
          staking.stakedPrincipal,

        pendingStakingRewards:
          staking.pendingRewards,

        network:
          "Pi Mainnet",

        environment:
          "MAINNET",

        // Referral code of this Pioneer (saved from Pi username on login)
        referralCode:
          req.member.referral_code ||
          req.member.username ||
          req.piUser.username ||
          null
      });

    } catch (error) {
      console.error(
        "USERS COMPATIBILITY ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to load Pioneer account."
        });
    }
  }
);

/* ---------------------------------------------------------
GET /api/balance
--------------------------------------------------------- */

app.get(
  "/api/balance",
  requireAuth,
  async (req, res) => {
    try {
      const balance =
        await getBalance(
          req.member.id
        );

      const staking =
        await getStakingSummary(
          req.member.id
        );

      res.json({
        ok: true,

        balance,

        availableBalance:
          balance,

        stakedBalance:
          staking.stakedPrincipal,

        pendingStakingRewards:
          staking.pendingRewards,

        totalBalance:
          Number(
            (
              balance +
              staking.stakedPrincipal
            ).toFixed(8)
          ),

        symbol:
          "AMT",

        network:
          "Pi Mainnet",

        walletAddress:
          req.wallet
            .wallet_address,

        piWalletAddress:
          req.piUser.walletAddress ||
          null
      });

    } catch (error) {
      console.error(
        "BALANCE COMPATIBILITY ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to load AMT balance."
        });
    }
  }
);

/* ---------------------------------------------------------
POST /api/ledger/send
--------------------------------------------------------- */

app.post(
  "/api/ledger/send",
  requireAuth,
  async (req, res) => {
    const recipientAddress =
      String(
        req.body?.recipientAddress ||
        req.body?.to ||
        req.body?.recipient ||
        ""
      )
        .trim()
        .toUpperCase();

    const amount =
      validAmount(
        req.body?.amount
      );

    const memo =
      String(
        req.body?.memo || ""
      )
        .trim()
        .slice(0, 160);

    if (!recipientAddress) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Recipient AMT address is required."
        });
    }

    if (amount === null) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Invalid amount. Maximum 8 decimal places."
        });
    }

    try {
      const result =
        await performAmtTransfer(
          req.member,
          recipientAddress,
          amount,
          memo
        );

      res.json({
        ok: true,

        ...result,

        network:
          "Pi Mainnet",

        walletType:
          "AMT_MAINNET_LEDGER"
      });

    } catch (error) {
      console.error(
        "LEDGER SEND COMPATIBILITY ERROR:",
        error
      );

      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,

          error:
            error.message ||
            "AMT transfer failed.",

          ...(error.extra || {})
        });
    }
  }
);

/* ---------------------------------------------------------
GET /api/referrals
--------------------------------------------------------- */

app.get(
  "/api/referrals",
  requireAuth,
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT

            r.id,

            r.status,

            r.created_at,

            m.id AS member_id,

            m.username,

            m.pi_uid

          FROM referrals r

          JOIN members m
            ON m.id =
               r.referred_member_id

          WHERE
            r.referrer_member_id = $1

          ORDER BY
            r.created_at DESC
          `,
          [req.member.id]
        );

      const activeMiners =
        await pool.query(
          `
          SELECT
            COUNT(*)::INT AS count
          FROM referrals r
          JOIN mining_sessions ms
            ON ms.member_id =
               r.referred_member_id
          WHERE
            r.referrer_member_id = $1
            AND r.status = 'ACTIVE'
            AND ms.status = 'ACTIVE'
            AND NOW() < ms.ends_at
          `,
          [req.member.id]
        );

      const referralCount = result.rows.length;
      const currentTier = getReferralTier(referralCount);

      res.json({
        ok: true,

        // Referral code of this Pioneer (saved from Pi username on login)
        referralCode:
          req.member.referral_code ||
          req.member.username ||
          req.piUser.username ||
          null,

        username:
          req.member.username,

        count: referralCount,

        referralCount,

        activeMiners:
          Number(
            activeMiners.rows[0]?.count || 0
          ),

        // Tier system info
        tier: {
          name: currentTier.name,
          rewardPerReferral: currentTier.rewardPerReferral,
          min: currentTier.min,
          max: currentTier.max === Infinity ? null : currentTier.max
        },

        tiers: REFERRAL_TIERS.map(t => ({
          name: t.name,
          min: t.min,
          max: t.max === Infinity ? null : t.max,
          rewardPerReferral: t.rewardPerReferral
        })),

        milestones: REFERRAL_MILESTONES,

        referrals:
          result.rows
      });

    } catch (error) {
      console.error(
        "REFERRALS COMPATIBILITY ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to load referrals."
        });
    }
  }
);

/* ---------------------------------------------------------
POST /api/referrals/apply
--------------------------------------------------------- */

app.post(
  "/api/referrals/apply",
  requireAuth,
  async (req, res) => {
    const referralMemberId =
      Number(
        req.body?.referralMemberId ??
        req.body?.memberId
      );

    if (
      !Number.isInteger(
        referralMemberId
      )
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Valid referralMemberId is required."
        });
    }

    if (
      referralMemberId ===
      Number(req.member.id)
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "You cannot refer yourself."
        });
    }

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      const referredMember =
        await client.query(
          `
          SELECT
            id,
            username,
            pi_uid
          FROM members
          WHERE id = $1
          LIMIT 1
          `,
          [referralMemberId]
        );

      if (
        !referredMember.rows.length
      ) {
        throw new HttpError(
          404,
          "Referral Pioneer was not found."
        );
      }

      const existing =
        await client.query(
          `
          SELECT
            id,
            referrer_member_id,
            referred_member_id,
            status
          FROM referrals
          WHERE
            referred_member_id = $1
          LIMIT 1
          FOR UPDATE
          `,
          [referralMemberId]
        );

      if (
        existing.rows.length
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(409)
          .json({
            ok: false,
            error:
              "This Pioneer already has a referrer."
          });
      }

      await client.query(
        `
        INSERT INTO referrals
          (
            referrer_member_id,
            referred_member_id,
            status
          )
        VALUES
          (
            $1,
            $2,
            'ACTIVE'
          )
        `,
        [
          req.member.id,
          referralMemberId
        ]
      );

      const addedToCircle =
        await addReferralToSecurityCircle(
          client,
          req.member.id,
          referralMemberId
        );

      const countRes = await client.query(
        `
        SELECT COUNT(*)::INT AS count
        FROM referrals
        WHERE referrer_member_id = $1
          AND status = 'ACTIVE'
        `,
        [req.member.id]
      );
      const newCount = Number(countRes.rows[0]?.count || 0);

      const rewardInfo = await creditReferralReward(
        req.member.id,
        newCount,
        client,
        referralMemberId
      );

      await client.query(
        "COMMIT"
      );

      res.json({
        ok: true,

        applied:
          true,

        linked:
          true,

        referralMemberId,

        addedToSecurityCircle:
          addedToCircle,

        referralReward: rewardInfo
      });

    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "REFERRAL APPLY ERROR:",
        error
      );

      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,

          error:
            error.message ||
            "Unable to apply referral."
        });

    } finally {
      client.release();
    }
  }
);

/* ---------------------------------------------------------
GET /api/security-circle
--------------------------------------------------------- */

app.get(
  "/api/security-circle",
  requireAuth,
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT

            m.id,

            m.username,

            m.pi_uid,

            sc.status,

            sc.created_at,

            EXISTS (
              SELECT 1
              FROM mining_sessions ms
              WHERE
                ms.member_id = m.id
                AND ms.status = 'ACTIVE'
                AND NOW() < ms.ends_at
            ) AS mining

          FROM security_circle sc

          JOIN members m
            ON m.id =
               sc.member_id

          WHERE
            sc.owner_member_id = $1
            AND sc.status = 'ACTIVE'

          ORDER BY
            sc.created_at ASC
          `,
          [req.member.id]
        );

      res.json({
        ok: true,

        maxMembers:
          MAX_SECURITY_CIRCLE,

        count:
          result.rows.length,

        members:
          result.rows
      });

    } catch (error) {
      console.error(
        "SECURITY CIRCLE COMPATIBILITY ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to load Security Circle."
        });
    }
  }
);

/* ---------------------------------------------------------
POST /api/profile/image
--------------------------------------------------------- */

app.post(
  "/api/profile/image",
  requireAuth,
  async (req, res) => {
    try {
      // Accept common field names used by different frontends
      const image =
        String(
          req.body?.image ||
          req.body?.profileImage ||
          req.body?.photo ||
          req.body?.profile_image ||
          req.body?.avatar ||
          ""
        ).trim();

      if (!image) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Profile image is required. Send base64 as 'image' or 'profileImage'."
          });
      }

      if (
        !image.startsWith(
          "data:image/"
        )
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Invalid image format. Must start with data:image/ (base64)."
          });
      }

      // Increased limit: ~3MB base64 (~2.2MB actual image)
      if (
        image.length > 4000000
      ) {
        return res
          .status(413)
          .json({
            ok: false,
            error:
              "Profile image is too large. Max ~2MB."
          });
      }

      await pool.query(
        `
        UPDATE members
        SET
          profile_image = $1,
          updated_at = NOW()
        WHERE id = $2
        `,
        [
          image,
          req.member.id
        ]
      );

      res.json({
        ok: true,

        profileImage:
          image,

        saved: true
      });

    } catch (error) {
      console.error(
        "PROFILE IMAGE ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to save profile image.",
          detail:
            error.message || null
        });
    }
  }
);

/* ---------------------------------------------------------
DELETE /api/profile/image
--------------------------------------------------------- */

app.delete(
  "/api/profile/image",
  requireAuth,
  async (req, res) => {
    try {
      await pool.query(
        `
        UPDATE members
        SET
          profile_image = NULL,
          updated_at = NOW()
        WHERE id = $1
        `,
        [req.member.id]
      );

      res.json({
        ok: true,

        profileImage:
          null
      });

    } catch (error) {
      console.error(
        "DELETE PROFILE IMAGE ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to remove profile image."
        });
    }
  }
);

/* =========================================================
ERROR HANDLER
========================================================= */

app.use(
  (err, req, res, next) => {
    console.error(
      "UNHANDLED ERROR:",
      err
    );

    if (
      res.headersSent
    ) {
      return next(err);
    }

    res
      .status(
        err.status || 500
      )
      .json({
        ok: false,

        error:
          err.message ||
          "Internal server error."
      });
  }
);




/* =========================================================
   LUCKY SPIN — 3 spins per UTC day per member
   GET  /api/spin/status
   POST /api/spin/claim
========================================================= */

const SPIN_MAX_PER_DAY = 3;
// 8 segments — AMT rewards + free spin + rare 100 jackpot
/* MUST match wheel label order (clockwise from top):
   0:5  1:25  2:EGG  3:10  4:FREE  5:50  6:15  7:100 */
const SPIN_PRIZES = [
  { key: "amt_5",     label: "+5 AMT",              type: "amt",       amount: 5,   weight: 16 },
  { key: "amt_25",    label: "+25 AMT",             type: "amt",       amount: 25,  weight: 11 },
  { key: "egg",       label: "Free Egg!",           type: "egg",       amount: 0,   weight: 10 },
  { key: "amt_10",    label: "+10 AMT",             type: "amt",       amount: 10,  weight: 14 },
  { key: "free_spin", label: "FREE SPIN!",          type: "free_spin", amount: 0,   weight: 14 },
  { key: "amt_50",    label: "+50 AMT",             type: "amt",       amount: 50,  weight: 7 },
  { key: "amt_15",    label: "+15 AMT",             type: "amt",       amount: 15,  weight: 15 },
  { key: "jackpot",   label: "JACKPOT +100 AMT!",   type: "amt",       amount: 100, weight: 3 }
];

function pickSpinPrize(){
  const total = SPIN_PRIZES.reduce((a, p) => a + p.weight, 0);
  let r = Math.random() * total;
  for (let i = 0; i < SPIN_PRIZES.length; i++){
    r -= SPIN_PRIZES[i].weight;
    if (r <= 0) return { prize: SPIN_PRIZES[i], index: i };
  }
  return { prize: SPIN_PRIZES[0], index: 0 };
}

async function ensureSpinTable(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lucky_spins (
      id SERIAL PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      spin_date DATE NOT NULL,
      prize_key TEXT NOT NULL,
      prize_label TEXT,
      amount NUMERIC(18,6) DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_lucky_spins_member_date
    ON lucky_spins(member_id, spin_date)
  `);
}

app.get("/api/spin/status", requireAuth, async (req, res) => {
  try {
    await ensureSpinTable();
    const today = new Date().toISOString().slice(0, 10);
    const q = await pool.query(
      `SELECT
         COUNT(*)::int AS c,
         COUNT(*) FILTER (WHERE prize_key = 'free_spin')::int AS bonus
       FROM lucky_spins
       WHERE member_id = $1 AND spin_date = $2`,
      [req.member.id, today]
    );
    const used = q.rows[0] ? q.rows[0].c : 0;
    const bonus = q.rows[0] ? q.rows[0].bonus : 0;
    // Free-spin wins grant +1 extra spin for the day
    const left = Math.max(0, SPIN_MAX_PER_DAY + bonus - used);
    res.json({
      ok: true,
      usedToday: used,
      bonusSpins: bonus,
      spinsLeft: left,
      maxPerDay: SPIN_MAX_PER_DAY,
      canSpin: left > 0
    });
  } catch (e) {
    console.error("SPIN STATUS:", e);
    res.status(500).json({ ok: false, error: "Spin status failed." });
  }
});

app.post("/api/spin/claim", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureSpinTable();
    await client.query("BEGIN");
    await client.query(`SELECT id FROM members WHERE id = $1 FOR UPDATE`, [req.member.id]);

    const today = new Date().toISOString().slice(0, 10);
    const q = await client.query(
      `SELECT
         COUNT(*)::int AS c,
         COUNT(*) FILTER (WHERE prize_key = 'free_spin')::int AS bonus
       FROM lucky_spins
       WHERE member_id = $1 AND spin_date = $2`,
      [req.member.id, today]
    );
    const used = q.rows[0] ? q.rows[0].c : 0;
    const bonus = q.rows[0] ? q.rows[0].bonus : 0;
    const leftBefore = Math.max(0, SPIN_MAX_PER_DAY + bonus - used);
    if (leftBefore <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "No spins left today. Come back after UTC midnight."
      });
    }

    const { prize, index } = pickSpinPrize();

    await client.query(
      `INSERT INTO lucky_spins (member_id, spin_date, prize_key, prize_label, amount)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.member.id, today, prize.key, prize.label, prize.amount || 0]
    );

    // Credit rewards
    if (prize.type === "amt" && prize.amount > 0) {
      const ref = "SPIN-" + req.member.id + "-" + today + "-" + (used + 1);
      // Always credit balance via ledger (idempotent on reference)
      const exists = await client.query(
        `SELECT id FROM amt_ledger WHERE member_id = $1 AND reference = $2 LIMIT 1`,
        [req.member.id, ref]
      );
      if (!exists.rows.length) {
        await client.query(
          `INSERT INTO amt_ledger (member_id, amount, type, reference)
           VALUES ($1, $2, 'LUCKY_SPIN', $3)`,
          [req.member.id, prize.amount, ref]
        );
      }
    }
    // Free egg from spin → Baby Room (must include element — NOT NULL column)
    let eggGranted = false;
    let eggId = null;
    if (prize.type === "egg") {
      try {
        await ensurePetTables();
        const ELEMENTS = ["Earth","Water","Nature","Ice","Fire","Wind","Thunder"];
        const element = ELEMENTS[Math.floor(Math.random() * ELEMENTS.length)];
        const eggIns = await client.query(
          `INSERT INTO pet_eggs (member_id, element, rarity, status, hatch_at, gen, is_listed)
           VALUES ($1, $2, 'Common', 'INCUBATING', NOW() + INTERVAL '24 hours', 1, FALSE)
           RETURNING id, element, hatch_at`,
          [req.member.id, element]
        );
        if (eggIns.rows.length) {
          eggGranted = true;
          eggId = eggIns.rows[0].id;
        }
      } catch (eggErr) {
        console.error("spin egg grant FAILED:", eggErr.message);
      }
    }
    if (prize.type === "charge") {
      try {
        await client.query(
          `UPDATE members SET battle_charges = COALESCE(battle_charges,0) + 1
           WHERE id = $1`,
          [req.member.id]
        );
      } catch (chErr) {
        console.warn("spin charge grant:", chErr.message);
      }
    }

    await client.query("COMMIT");
    try { await bumpMission(req.member.id, "spin", 1); } catch (_) {}
    const newUsed = used + 1;
    const newBonus = bonus + (prize.type === "free_spin" ? 1 : 0);
    const left = Math.max(0, SPIN_MAX_PER_DAY + newBonus - newUsed);
    res.json({
      ok: true,
      prize: prize.key,
      prizeLabel: prize.type === "egg"
        ? (eggGranted ? "Free Egg! → Pets → Eggs / Baby Room (24h)" : "Egg prize (save failed — contact admin)")
        : prize.label,
      prizeIndex: index,
      amount: prize.amount || 0,
      spinsLeft: left,
      usedToday: newUsed,
      bonusSpins: newBonus,
      freeSpin: prize.type === "free_spin",
      eggGranted: !!eggGranted,
      eggId: eggId
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("SPIN CLAIM:", e);
    res.status(500).json({ ok: false, error: e.message || "Spin failed." });
  } finally {
    client.release();
  }
});


/* =========================================================
DAILY MINING AD BONUS (in-app AMT · 1x per UTC day per member)
POST /api/ads/mining-bonus  (authenticated)
Env: AD_MINING_BONUS_AMT (default 0.5)
========================================================= */

app.post(
  "/api/ads/mining-bonus",
  requireAuth,
  async (req, res) => {
    try {
      const bonus = Math.min(
        50,
        Math.max(
          0.01,
          Number(process.env.AD_MINING_BONUS_AMT || "0.5")
        )
      );
      const dayKey = new Date()
        .toISOString()
        .slice(0, 10);
      // reference must be globally unique (amt_ledger_reference_key)
      const ref = "AD-MINING-" + req.member.id + "-" + dayKey;

      const exists = await pool.query(
        `SELECT id FROM amt_ledger
         WHERE member_id = $1 AND reference = $2
         LIMIT 1`,
        [req.member.id, ref]
      );
      if (exists.rows.length) {
        const bal = await getBalance(req.member.id);
        return res.json({
          ok: true,
          credited: false,
          amount: 0,
          balance: bal,
          message: "Ad bonus already claimed today."
        });
      }

      try {
        await pool.query(
          `INSERT INTO amt_ledger (member_id, amount, type, reference)
           VALUES ($1, $2, 'AD_MINING_BONUS', $3)`,
          [req.member.id, bonus, ref]
        );
      } catch (insErr) {
        // Race: unique reference or double-click
        if (insErr && insErr.code === "23505") {
          const bal = await getBalance(req.member.id);
          return res.json({
            ok: true,
            credited: false,
            amount: 0,
            balance: bal,
            message: "Ad bonus already claimed today."
          });
        }
        throw insErr;
      }
      const bal = await getBalance(req.member.id);
      return res.json({
        ok: true,
        credited: true,
        amount: bonus,
        balance: bal,
        message: "Ad bonus +" + bonus + " AMT"
      });
    } catch (err) {
      console.error("AD MINING BONUS:", err);
      return res.status(500).json({
        ok: false,
        error: err.message || "Ad bonus failed."
      });
    }
  }
);

/* =========================================================
DEV TREASURY CLAIM — one-time 5M in-app AMT for developer account
POST /api/dev/claim-treasury  (authenticated)
Matches DEV_PI_USERNAMES / DEV_PI_UIDS / DEV_LEDGER_ADDRESS
========================================================= */

app.post(
  "/api/dev/claim-treasury",
  requireAuth,
  async (req, res) => {
    try {
      const ok = await ensureDevTreasury(
        req.member,
        req.piUser,
        req.wallet
      );
      const bal = await getBalance(req.member.id);
      return res.json({
        ok: true,
        credited: !!ok,
        balance: bal,
        amount: DEV_TREASURY_AMT,
        username: req.member.username || (req.piUser && req.piUser.username),
        ledger:
          (req.wallet && req.wallet.wallet_address) || null,
        message: ok
          ? "Developer treasury credited."
          : "No new credit (already claimed or username/ledger/uid not in env match)."
      });
    } catch (err) {
      console.error("CLAIM TREASURY:", err);
      return res.status(500).json({
        ok: false,
        error: err.message || "Claim failed."
      });
    }
  }
);

/* =========================================================
TESTNET A2U (App → User) — for Pi "5 unique wallets" requirement
Env required on Render (Testnet service only):
  PI_API_KEY              = Testnet app API key
  PI_WALLET_PRIVATE_SEED  = Testnet app wallet seed (starts with S) — SECRET
Optional:
  A2U_TEST_AMOUNT         = amount of Test-Pi per payout (default 0.01)
========================================================= */

app.post(
  "/api/test/a2u",
  requireAuth,
  async (req, res) => {
    try {
      const seed = String(
        process.env.PI_WALLET_PRIVATE_SEED || ""
      ).trim();
      const apiKey = String(
        process.env.PI_API_KEY || ""
      ).trim();

      if (!apiKey || !seed) {
        return res.status(503).json({
          ok: false,
          error:
            "A2U not configured. Set PI_API_KEY and PI_WALLET_PRIVATE_SEED on Render (Testnet)."
        });
      }

      if (!seed.startsWith("S")) {
        return res.status(500).json({
          ok: false,
          error:
            "PI_WALLET_PRIVATE_SEED must be a secret seed starting with S."
        });
      }

      const uid = String(
        req.member.pi_uid || ""
      ).trim();
      if (!uid) {
        return res.status(400).json({
          ok: false,
          error:
            "Missing Pi user uid. Re-login with Pi on the Testnet app."
        });
      }

      // One successful A2U test payout per member (enough for uniqueness count)
      const prior = await pool.query(
        `
        SELECT id FROM amt_ledger
        WHERE member_id = $1
          AND type = 'A2U_TEST_PAYOUT'
        LIMIT 1
        `,
        [req.member.id]
      );
      if (prior.rows.length > 0) {
        return res.status(400).json({
          ok: false,
          error:
            "This account already received a test A2U payout. Use another Pi account for remaining unique wallets."
        });
      }

      const amount = Math.min(
        1,
        Math.max(
          0.001,
          Number(process.env.A2U_TEST_AMOUNT || "0.01")
        )
      );

      let PiNetworkMod;
      try {
        PiNetworkMod = require("pi-backend");
      } catch (e) {
        return res.status(503).json({
          ok: false,
          error:
            "pi-backend package not installed. Add pi-backend to package.json and redeploy."
        });
      }

      // CJS/ESM interop: package may export default or named class
      const PiNetwork =
        (typeof PiNetworkMod === "function" && PiNetworkMod) ||
        (PiNetworkMod && typeof PiNetworkMod.default === "function" && PiNetworkMod.default) ||
        (PiNetworkMod && typeof PiNetworkMod.PiNetwork === "function" && PiNetworkMod.PiNetwork) ||
        null;

      if (!PiNetwork) {
        return res.status(500).json({
          ok: false,
          error:
            "pi-backend loaded but PiNetwork constructor not found. Check package version."
        });
      }

      const pi = new PiNetwork(apiKey, seed);

      // Clear stuck incomplete server payments if any
      try {
        const incomplete =
          await pi.getIncompleteServerPayments();
        if (
          Array.isArray(incomplete) &&
          incomplete.length
        ) {
          for (const p of incomplete) {
            const id = p.identifier || p.paymentId;
            if (!id) continue;
            try {
              if (
                p.transaction &&
                p.transaction.txid
              ) {
                await pi.completePayment(
                  id,
                  p.transaction.txid
                );
              } else {
                await pi.cancelPayment(id);
              }
            } catch (e2) {
              console.warn(
                "A2U incomplete cleanup:",
                e2.message || e2
              );
            }
          }
        }
      } catch (e) {
        console.warn(
          "getIncompleteServerPayments:",
          e.message || e
        );
      }

      const paymentData = {
        amount,
        memo: "AMT Testnet A2U test payout",
        metadata: {
          purpose: "a2u_unique_wallet_test",
          member_id: req.member.id
        },
        uid
      };

      const paymentId =
        await pi.createPayment(paymentData);
      const txid =
        await pi.submitPayment(paymentId);
      const completed =
        await pi.completePayment(
          paymentId,
          txid
        );

      // Audit row only (amount 0 so in-app AMT balance is unchanged — Test-Pi is on-chain)
      try {
        await pool.query(
          `
          INSERT INTO amt_ledger
            (member_id, amount, type, reference)
          VALUES
            ($1, 0, 'A2U_TEST_PAYOUT', $2)
          `,
          [
            req.member.id,
            "A2U-" + String(paymentId)
          ]
        );
      } catch (e) {
        console.warn(
          "A2U ledger audit:",
          e.message || e
        );
      }

      return res.json({
        ok: true,
        amount,
        paymentId,
        txid,
        to_address:
          completed && completed.to_address
            ? completed.to_address
            : null,
        direction:
          completed && completed.direction
            ? completed.direction
            : "app_to_user",
        message:
          "A2U test payout submitted. Check Test-Pi wallet. Need 5 unique wallets total."
      });
    } catch (err) {
      console.error(
        "A2U ERROR:",
        err && err.response
          ? err.response.data
          : err
      );
      return res.status(500).json({
        ok: false,
        error:
          (err && err.message) ||
          "A2U payout failed."
      });
    }
  }
);

/* =========================================================
START SERVER
========================================================= */

async function startServer() {
  try {
    await initializeDatabase();

    
/* AMT_ERR_HANDLER */
app.use((err, req, res, next) => {
  const status = Number(err && err.status) || 500;
  if (status >= 500) {
    console.error("UNHANDLED:", err && err.message ? err.message : err);
  } else {
    console.warn("HTTP", status, err && err.message ? err.message : "", req.method, req.path);
  }
  if (res.headersSent) return next(err);
  res.status(status).json({
    ok: false,
    error: (err && err.message) || "Request failed.",
    ...(err && err.extra ? err.extra : {})
  });
});


/* === DAILY MISSIONS + DUNGEON (hoisted before listen) === */
const DAILY_MISSIONS = [
  { id: "mine", label: "Start mining once", target: 1, rewardAmt: 1 },
  { id: "spin", label: "Spin the wheel once", target: 1, rewardAmt: 1 },
  { id: "care", label: "Care a pet once", target: 1, rewardAmt: 1 },
  { id: "battle", label: "Win 1 pet battle", target: 1, rewardAmt: 2 }
];
const MISSION_ALL_BONUS = 3; // AMT when all 4 done

const DUNGEON_DURATIONS = {
  "1h": { hours: 1, cost: 0.2, lootMult: 1 },
  "2h": { hours: 2, cost: 0.4, lootMult: 1.6 },
  "4h": { hours: 4, cost: 0.7, lootMult: 2.5 }
};

async function ensureMissionTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_missions (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      mission_date DATE NOT NULL,
      mission_id TEXT NOT NULL,
      progress INT NOT NULL DEFAULT 0,
      target INT NOT NULL DEFAULT 1,
      claimed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(member_id, mission_date, mission_id)
    );
    CREATE TABLE IF NOT EXISTS daily_mission_bonus (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      mission_date DATE NOT NULL,
      claimed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(member_id, mission_date)
    );
    CREATE TABLE IF NOT EXISTS dungeon_runs (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      owned_pet_id BIGINT NOT NULL REFERENCES owned_pets(id) ON DELETE CASCADE,
      duration_key TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ends_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      loot_json TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_daily_missions_member ON daily_missions(member_id, mission_date);
    CREATE INDEX IF NOT EXISTS idx_dungeon_member ON dungeon_runs(member_id, status);
  `);
}

async function ensureDailyGoalsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_goals (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      goal_date DATE NOT NULL,
      mine BOOLEAN NOT NULL DEFAULT FALSE,
      spin BOOLEAN NOT NULL DEFAULT FALSE,
      care BOOLEAN NOT NULL DEFAULT FALSE,
      battle BOOLEAN NOT NULL DEFAULT FALSE,
      bonus_claimed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (member_id, goal_date)
    );
    CREATE TABLE IF NOT EXISTS dungeon_runs (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      owned_pet_id BIGINT NOT NULL REFERENCES owned_pets(id) ON DELETE CASCADE,
      duration_key TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ends_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      loot_json TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS mystery_chests (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      chest_date DATE NOT NULL,
      reward_key TEXT NOT NULL,
      reward_label TEXT NOT NULL,
      amount NUMERIC(18,8) NOT NULL DEFAULT 0,
      is_secret_day BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (member_id, chest_date)
    );
  `);
}

function isSecretRewardDay(d = new Date()) {
  return d.getUTCDay() === 0; // Sunday UTC
}


function rollDungeonLoot(lootMult) {
  const mult = Math.max(0.5, Number(lootMult) || 1);
  const picks = [];
  // 1–3 food
  picks.push({ item: "food", qty: Math.max(1, Math.round((1 + Math.floor(Math.random() * 3)) * mult)) });
  // water
  if (Math.random() < 0.85) {
    picks.push({ item: "water", qty: Math.max(1, Math.round((1 + Math.floor(Math.random() * 2)) * mult)) });
  }
  // energy
  if (Math.random() < 0.7) {
    picks.push({ item: "energy", qty: Math.max(1, Math.round((1 + Math.floor(Math.random() * 2)) * mult)) });
  }
  // small AMT
  if (Math.random() < 0.55) {
    const amt = Math.round((0.2 + Math.random() * 0.8 * mult) * 100) / 100;
    if (amt > 0) picks.push({ item: "amt", qty: amt });
  }
  // rare gem / core
  if (Math.random() < 0.12 * mult) picks.push({ item: "gem", qty: 1 });
  if (Math.random() < 0.08 * mult) picks.push({ item: "upgrade_core", qty: 1 });
  return picks;
}

function rollMysteryReward(secret) {
  const pool = secret
    ? [
        { key: "amt_2", label: "2 AMT", amount: 2, w: 25 },
        { key: "amt_5", label: "5 AMT", amount: 5, w: 30 },
        { key: "amt_10", label: "10 AMT", amount: 10, w: 18 },
        { key: "amt_25", label: "25 AMT", amount: 25, w: 8 },
        { key: "gem", label: "Mystery Gem ×1", amount: 0, w: 10 },
        { key: "core", label: "Upgrade Core ×1", amount: 0, w: 6 },
        { key: "egg", label: "Mystery Egg", amount: 0, w: 2 },
        { key: "jackpot", label: "SECRET JACKPOT 50 AMT", amount: 50, w: 1 }
      ]
    : [
        { key: "amt_1", label: "1 AMT", amount: 1, w: 30 },
        { key: "amt_2", label: "2 AMT", amount: 2, w: 28 },
        { key: "amt_3", label: "3 AMT", amount: 3, w: 18 },
        { key: "amt_5", label: "5 AMT", amount: 5, w: 10 },
        { key: "gem", label: "Mystery Gem ×1", amount: 0, w: 8 },
        { key: "core", label: "Upgrade Core ×1", amount: 0, w: 4 },
        { key: "egg", label: "Mystery Egg", amount: 0, w: 1.5 },
        { key: "jackpot", label: "JACKPOT 20 AMT", amount: 20, w: 0.5 }
      ];
  const total = pool.reduce((a, p) => a + p.w, 0);
  let r = Math.random() * total;
  for (const p of pool) {
    r -= p.w;
    if (r <= 0) return p;
  }
  return pool[0];
}

async function bumpMission(memberId, missionId, amount) {
  try {
    if (!memberId || !missionId) return;
    await ensureDailyGoalsTable();
    const col = { mine: "mine", spin: "spin", care: "care", battle: "battle" }[String(missionId)];
    if (!col) return;
    const today = utcDateString();
    await pool.query(
      `INSERT INTO daily_goals (member_id, goal_date, ${col})
       VALUES ($1, $2::date, TRUE)
       ON CONFLICT (member_id, goal_date)
       DO UPDATE SET ${col} = TRUE`,
      [memberId, today]
    );
    console.log("dailyGoal", col, memberId, today);
  } catch (e) {
    console.error("dailyGoal FAIL", missionId, e.message || e);
  }
}


app.get("/api/missions/status", requireAuth, async (req, res) => {
  try {
    await ensureDailyGoalsTable();
    const today = utcDateString();
    const r = await pool.query(
      `SELECT mine, spin, care, battle, bonus_claimed FROM daily_goals
       WHERE member_id = $1 AND goal_date = $2::date`,
      [req.member.id, today]
    );
    const row = r.rows[0] || {};
    const goals = [
      { id: "mine", label: "Start or claim mining today", done: !!row.mine, rewardAmt: 0 },
      { id: "spin", label: "Spin the wheel once", done: !!row.spin, rewardAmt: 0 },
      { id: "care", label: "Care a pet (or Care All)", done: !!row.care, rewardAmt: 0 },
      { id: "battle", label: "Win 1 pet battle", done: !!row.battle, rewardAmt: 0 }
    ];
    const doneCount = goals.filter(g => g.done).length;
    const need = 3;
    const bonusClaimed = !!row.bonus_claimed;
    const bonusReady = doneCount >= need && !bonusClaimed;
    res.json({
      ok: true,
      date: today,
      mode: "goals",
      goals,
      // compat for old UI
      missions: goals.map(g => ({
        id: g.id,
        label: g.label,
        progress: g.done ? 1 : 0,
        target: 1,
        complete: g.done,
        claimed: false,
        rewardAmt: 0
      })),
      doneCount,
      need,
      bonus: {
        amount: 5,
        claimed: bonusClaimed,
        available: bonusReady
      },
      allDone: doneCount >= need
    });
  } catch (e) {
    console.error("GOALS STATUS:", e);
    res.status(500).json({ ok: false, error: e.message || "goals failed" });
  }
});

app.post("/api/missions/claim", requireAuth, async (req, res) => {
  // Individual mission claims removed — use all-clear bonus only
  return res.json({
    ok: false,
    error: "Complete 3 goals then claim the daily bonus below."
  });
});

app.post("/api/missions/claim-bonus", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureDailyGoalsTable();
    const today = utcDateString();
    await client.query("BEGIN");
    await client.query(`SELECT id FROM members WHERE id = $1 FOR UPDATE`, [req.member.id]);
    let row = await client.query(
      `SELECT mine, spin, care, battle, bonus_claimed FROM daily_goals
       WHERE member_id = $1 AND goal_date = $2::date FOR UPDATE`,
      [req.member.id, today]
    );
    if (!row.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "No goals progress yet today." });
    }
    const g = row.rows[0];
    if (g.bonus_claimed) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Daily bonus already claimed." });
    }
    const done = [g.mine, g.spin, g.care, g.battle].filter(Boolean).length;
    if (done < 3) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Need 3/4 goals done (you have " + done + "/4)." });
    }
    const amount = 5;
    await client.query(
      `UPDATE daily_goals SET bonus_claimed = TRUE WHERE member_id = $1 AND goal_date = $2::date`,
      [req.member.id, today]
    );
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference)
       VALUES ($1, $2, 'DAILY_GOAL_BONUS', $3)`,
      [req.member.id, amount, makeReference("AMT-GGOAL")]
    );
    await client.query("COMMIT");
    const balance = await getBalance(req.member.id);
    res.json({
      ok: true,
      amount,
      balance,
      message: "Daily Goals bonus +" + amount + " AMT"
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("GOAL BONUS:", e);
    res.status(500).json({ ok: false, error: e.message || "bonus failed" });
  } finally {
    client.release();
  }
});


app.get("/api/chest/status", requireAuth, async (req, res) => {
  try {
    await ensureDailyGoalsTable();
    const today = utcDateString();
    const secret = isSecretRewardDay();
    const row = await pool.query(
      `SELECT reward_key, reward_label, amount, is_secret_day, created_at
       FROM mystery_chests WHERE member_id = $1 AND chest_date = $2::date`,
      [req.member.id, today]
    );
    const opened = row.rows[0] || null;
    res.json({
      ok: true,
      date: today,
      secretDay: secret,
      title: secret ? "Secret Reward Day" : "Mystery Chest",
      subtitle: secret
        ? "Sunday special — higher chance of big surprises!"
        : "Open once per day · surprise inside",
      opened: !!opened,
      reward: opened
        ? { key: opened.reward_key, label: opened.reward_label, amount: Number(opened.amount) }
        : null
    });
  } catch (e) {
    console.error("CHEST STATUS:", e);
    res.status(500).json({ ok: false, error: e.message || "chest status failed" });
  }
});

app.post("/api/chest/open", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureDailyGoalsTable();
    const today = utcDateString();
    const secret = isSecretRewardDay();
    await client.query("BEGIN");
    await client.query(`SELECT id FROM members WHERE id = $1 FOR UPDATE`, [req.member.id]);
    const exists = await client.query(
      `SELECT id, reward_label, amount FROM mystery_chests
       WHERE member_id = $1 AND chest_date = $2::date FOR UPDATE`,
      [req.member.id, today]
    );
    if (exists.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "Already opened today. Come back after UTC midnight.",
        reward: { label: exists.rows[0].reward_label, amount: Number(exists.rows[0].amount) }
      });
    }
    const prize = rollMysteryReward(secret);
    await client.query(
      `INSERT INTO mystery_chests (member_id, chest_date, reward_key, reward_label, amount, is_secret_day)
       VALUES ($1, $2::date, $3, $4, $5, $6)`,
      [req.member.id, today, prize.key, prize.label, prize.amount || 0, secret]
    );
    if (prize.amount > 0) {
      await client.query(
        `INSERT INTO amt_ledger (member_id, amount, type, reference)
         VALUES ($1, $2, 'MYSTERY_CHEST', $3)`,
        [req.member.id, prize.amount, makeReference("AMT-CHEST")]
      );
    }
    if (prize.key === "gem" || prize.key === "core") {
      try {
        await client.query(
          `INSERT INTO pet_inventory (member_id, gear_id, qty)
           VALUES ($1, $2, 1)
           ON CONFLICT (member_id, gear_id)
           DO UPDATE SET qty = pet_inventory.qty + 1`,
          [req.member.id, prize.key === "gem" ? "gem" : "upgrade_core"]
        );
      } catch (_) {}
    }
    if (prize.key === "egg") {
      try {
        await ensurePetTables();
        const ELEMENTS = ["Earth","Water","Nature","Ice","Fire","Wind","Thunder"];
        const element = ELEMENTS[Math.floor(Math.random() * ELEMENTS.length)];
        await client.query(
          `INSERT INTO pet_eggs (member_id, element, rarity, status, hatch_at, gen, is_listed)
           VALUES ($1, $2, 'Common', 'INCUBATING', NOW() + INTERVAL '24 hours', 1, FALSE)`,
          [req.member.id, element]
        );
      } catch (eggErr) {
        console.warn("chest egg:", eggErr.message);
      }
    }
    await client.query("COMMIT");
    const balance = await getBalance(req.member.id);
    res.json({
      ok: true,
      secretDay: secret,
      reward: { key: prize.key, label: prize.label, amount: prize.amount || 0 },
      balance,
      message: (secret ? "✨ SECRET DAY! " : "📦 ") + prize.label
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("CHEST OPEN:", e);

    res.status(500).json({ ok: false, error: e.message || "open failed" });
  } finally {
    client.release();
  }
});

app.get("/api/dungeon/status", requireAuth, async (req, res) => {
  try {
    await ensureDailyGoalsTable();
    const active = await pool.query(
      `SELECT d.*, p.name AS pet_name, p.element, p.level, p.image
       FROM dungeon_runs d
       JOIN owned_pets p ON p.id = d.owned_pet_id
       WHERE d.member_id = $1 AND d.status = 'ACTIVE'
       ORDER BY d.ends_at DESC LIMIT 5`,
      [req.member.id]
    );
    const now = Date.now();
    const runs = active.rows.map((r) => ({
      id: r.id,
      petId: r.owned_pet_id,
      petName: r.pet_name,
      element: r.element,
      level: r.level,
      image: r.image,
      durationKey: r.duration_key,
      endsAt: r.ends_at,
      ready: new Date(r.ends_at).getTime() <= now,
      remainingMs: Math.max(0, new Date(r.ends_at).getTime() - now)
    }));
    res.json({ ok: true, runs, durations: DUNGEON_DURATIONS });
  } catch (e) {
    console.error("DUNGEON STATUS:", e);
    res.status(500).json({ ok: false, error: e.message || "dungeon status failed" });
  }
});

app.post("/api/dungeon/start", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureDailyGoalsTable();
    const petId = Number(req.body?.petId);
    const durationKey = String(req.body?.duration || "1h");
    const dur = DUNGEON_DURATIONS[durationKey];
    if (!petId || !dur) return res.status(400).json({ ok: false, error: "Invalid pet or duration" });

    await client.query("BEGIN");
    await client.query(`SELECT id FROM members WHERE id = $1 FOR UPDATE`, [req.member.id]);

    const pet = await client.query(
      `SELECT id, name, session_type, session_ends_at, pet_status, energy
       FROM owned_pets WHERE id = $1 AND member_id = $2 FOR UPDATE`,
      [petId, req.member.id]
    );
    if (!pet.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found" });
    }
    const p = pet.rows[0];
    if (String(p.pet_status || "ACTIVE") !== "ACTIVE") {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Pet not available" });
    }
    if (p.session_type && p.session_ends_at && new Date(p.session_ends_at) > new Date()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Pet is busy (care/train/dungeon)" });
    }
    const busy = await client.query(
      `SELECT id FROM dungeon_runs WHERE owned_pet_id = $1 AND status = 'ACTIVE' AND ends_at > NOW()`,
      [petId]
    );
    if (busy.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Pet already in dungeon" });
    }

    const bal = await getBalance(req.member.id);
    if (Number(bal) < dur.cost) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Need " + dur.cost + " AMT to enter dungeon" });
    }
    if (dur.cost > 0) {
      await client.query(
        `INSERT INTO amt_ledger (member_id, amount, type, reference)
         VALUES ($1, $2, 'DUNGEON_FEE', $3)`,
        [req.member.id, -dur.cost, makeReference("AMT-DUNG")]
      );
    }

    const ends = new Date(Date.now() + dur.hours * 3600 * 1000);
    const ins = await client.query(
      `INSERT INTO dungeon_runs (member_id, owned_pet_id, duration_key, ends_at, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE') RETURNING id, ends_at`,
      [req.member.id, petId, durationKey, ends.toISOString()]
    );
    await client.query(
      `UPDATE owned_pets SET session_type = 'DUNGEON', session_ends_at = $1, energy = GREATEST(0, COALESCE(energy,100) - 10)
       WHERE id = $2`,
      [ends.toISOString(), petId]
    );
    await client.query("COMMIT");
    res.json({
      ok: true,
      runId: ins.rows[0].id,
      endsAt: ins.rows[0].ends_at,
      cost: dur.cost,
      message: p.name + " entered the map for " + durationKey
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("DUNGEON START:", e);
    res.status(500).json({ ok: false, error: e.message || "start failed" });
  } finally {
    client.release();
  }
});

app.post("/api/dungeon/claim", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureDailyGoalsTable();
    const runId = Number(req.body?.runId);
    if (!runId) return res.status(400).json({ ok: false, error: "runId required" });
    await client.query("BEGIN");
    const run = await client.query(
      `SELECT * FROM dungeon_runs WHERE id = $1 AND member_id = $2 FOR UPDATE`,
      [runId, req.member.id]
    );
    if (!run.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Run not found" });
    }
    const r = run.rows[0];
    if (r.status !== "ACTIVE") {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Already claimed" });
    }
    if (new Date(r.ends_at) > new Date()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Still exploring — wait for timer" });
    }
    const dur = DUNGEON_DURATIONS[r.duration_key] || DUNGEON_DURATIONS["1h"];
    const loot = rollDungeonLoot(dur.lootMult);

    // Apply inventory-style items into pet needs / simple ledger for AMT
    for (const L of loot) {
      if (L.item === "amt" && L.qty > 0) {
        await client.query(
          `INSERT INTO amt_ledger (member_id, amount, type, reference)
           VALUES ($1, $2, 'DUNGEON_LOOT', $3)`,
          [req.member.id, L.qty, makeReference("AMT-DLOOT")]
        );
      } else if (L.item === "food") {
        await client.query(
          `UPDATE owned_pets SET hunger = LEAST(100, COALESCE(hunger,0) + $1 * 15)
           WHERE id = $2 AND member_id = $3`,
          [L.qty, r.owned_pet_id, req.member.id]
        );
      } else if (L.item === "water") {
        await client.query(
          `UPDATE owned_pets SET thirst = LEAST(100, COALESCE(thirst,0) + $1 * 15)
           WHERE id = $2 AND member_id = $3`,
          [L.qty, r.owned_pet_id, req.member.id]
        );
      } else if (L.item === "energy") {
        await client.query(
          `UPDATE owned_pets SET energy = LEAST(100, COALESCE(energy,0) + $1 * 20)
           WHERE id = $2 AND member_id = $3`,
          [L.qty, r.owned_pet_id, req.member.id]
        );
      } else if (L.item === "gem" || L.item === "upgrade_core") {
        // store as inventory if table exists
        try {
          await client.query(
            `INSERT INTO pet_inventory (member_id, gear_id, qty)
             VALUES ($1, $2, $3)
             ON CONFLICT (member_id, gear_id)
             DO UPDATE SET qty = pet_inventory.qty + EXCLUDED.qty`,
            [req.member.id, L.item, L.qty]
          );
        } catch (_) {
          /* inventory optional */
        }
      }
    }

    await client.query(
      `UPDATE dungeon_runs SET status = 'CLAIMED', loot_json = $1 WHERE id = $2`,
      [JSON.stringify(loot), runId]
    );
    await client.query(
      `UPDATE owned_pets SET session_type = NULL, session_ends_at = NULL WHERE id = $1`,
      [r.owned_pet_id]
    );
    // small XP
    await client.query(
      `UPDATE owned_pets SET exp = COALESCE(exp,0) + $1 WHERE id = $2`,
      [Math.round(8 * dur.lootMult), r.owned_pet_id]
    );

    await client.query("COMMIT");
    const balance = await getBalance(req.member.id);
    const lootText = (Array.isArray(loot) ? loot : [])
      .map((x) => (x.qty || 1) + " " + (x.item || "item"))
      .join(", ");
    res.json({
      ok: true,
      loot: loot || [],
      balance,
      message: lootText ? ("Dungeon loot: " + lootText) : "Dungeon complete!"
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("DUNGEON CLAIM:", e);
    res.status(500).json({ ok: false, error: e.message || "claim failed" });
  } finally {
    client.release();
  }
});


/* =========================================================
   WAR OUTPOST — Phase 1
========================================================= */
async function ensureWarTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS war_outposts (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT NOT NULL UNIQUE REFERENCES members(id) ON DELETE CASCADE,
      hp INT NOT NULL DEFAULT 100,
      max_hp INT NOT NULL DEFAULT 100,
      defense INT NOT NULL DEFAULT 10,
      trophy INT NOT NULL DEFAULT 0,
      level INT NOT NULL DEFAULT 1,
      last_raid_at TIMESTAMPTZ,
      last_defend_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS war_attacks (
      id BIGSERIAL PRIMARY KEY,
      attacker_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      defender_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      damage INT NOT NULL DEFAULT 0,
      loot_amt NUMERIC(18,8) NOT NULL DEFAULT 0,
      result TEXT NOT NULL,
      attacker_trophy_delta INT NOT NULL DEFAULT 0,
      defender_trophy_delta INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_war_attacks_attacker ON war_attacks(attacker_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_war_attacks_defender ON war_attacks(defender_id, created_at DESC);
  `);
}

async function getOrCreateOutpost(memberId, client) {
  const db = client || pool;
  let r = await db.query(`SELECT * FROM war_outposts WHERE member_id = $1`, [memberId]);
  if (r.rows.length) return r.rows[0];
  r = await db.query(
    `INSERT INTO war_outposts (member_id) VALUES ($1)
     ON CONFLICT (member_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [memberId]
  );
  return r.rows[0];
}

const WAR_UPGRADE_COST = 2; // in-app AMT
const WAR_RAID_COOLDOWN_MS = 15 * 60 * 1000; // 15 min between raids

app.get("/api/war/status", requireAuth, async (req, res) => {
  try {
    await ensureWarTables();
    const outpost = await getOrCreateOutpost(req.member.id);
    const log = await pool.query(
      `SELECT a.*, 
              atk.username AS attacker_username,
              def.username AS defender_username
       FROM war_attacks a
       LEFT JOIN members atk ON atk.id = a.attacker_id
       LEFT JOIN members def ON def.id = a.defender_id
       WHERE a.attacker_id = $1 OR a.defender_id = $1
       ORDER BY a.created_at DESC
       LIMIT 20`,
      [req.member.id]
    );
    let nextRaidIn = 0;
    if (outpost.last_raid_at) {
      const left = WAR_RAID_COOLDOWN_MS - (Date.now() - new Date(outpost.last_raid_at).getTime());
      if (left > 0) nextRaidIn = Math.ceil(left / 1000);
    }
    // Trophy rank title
    const trop = Number(outpost.trophy) || 0;
    let rankTitle = "Recruit";
    if (trop >= 500) rankTitle = "Warlord";
    else if (trop >= 300) rankTitle = "Commander";
    else if (trop >= 150) rankTitle = "Captain";
    else if (trop >= 80) rankTitle = "Knight";
    else if (trop >= 30) rankTitle = "Scout";

    // Top trophy board
    let board = [];
    try {
      const br = await pool.query(
        `SELECT o.trophy, o.level, o.defense, m.username
         FROM war_outposts o
         JOIN members m ON m.id = o.member_id
         ORDER BY o.trophy DESC, o.level DESC
         LIMIT 10`
      );
      board = br.rows.map((r, i) => ({
        rank: i + 1,
        username: r.username || "miner",
        trophy: r.trophy,
        level: r.level,
        defense: r.defense
      }));
    } catch (_) {}

    const myRankRow = await pool.query(
      `SELECT COUNT(*)::int AS higher FROM war_outposts WHERE trophy > $1`,
      [outpost.trophy]
    );
    const myRank = (myRankRow.rows[0]?.higher || 0) + 1;

    res.json({
      ok: true,
      outpost: {
        hp: outpost.hp,
        maxHp: outpost.max_hp,
        defense: outpost.defense,
        trophy: outpost.trophy,
        level: outpost.level,
        rankTitle: rankTitle,
        myRank: myRank
      },
      upgradeCost: WAR_UPGRADE_COST,
      nextRaidIn,
      board: board,
      log: log.rows.map((row) => ({
        id: row.id,
        result: row.result,
        damage: row.damage,
        lootAmt: Number(row.loot_amt),
        isAttacker: Number(row.attacker_id) === Number(req.member.id),
        otherUsername: Number(row.attacker_id) === Number(req.member.id)
          ? row.defender_username
          : row.attacker_username,
        trophyDelta: Number(row.attacker_id) === Number(req.member.id)
          ? row.attacker_trophy_delta
          : row.defender_trophy_delta,
        createdAt: row.created_at
      }))
    });
  } catch (e) {
    console.error("WAR STATUS:", e);
    res.status(500).json({ ok: false, error: e.message || "war status failed" });
  }
});

app.post("/api/war/upgrade", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureWarTables();
    await client.query("BEGIN");
    await client.query(`SELECT id FROM members WHERE id = $1 FOR UPDATE`, [req.member.id]);
    const outpost = await getOrCreateOutpost(req.member.id, client);
    const cost = WAR_UPGRADE_COST;
    const bal = await getBalance(req.member.id, client);
    if (bal < cost) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Need " + cost + " AMT to upgrade (have " + bal + ")." });
    }
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference)
       VALUES ($1, $2, 'WAR_UPGRADE', $3)`,
      [req.member.id, -cost, makeReference("AMT-WARUP")]
    );
    const newDef = Number(outpost.defense) + 5;
    const newMax = Number(outpost.max_hp) + 20;
    const newHp = Math.min(newMax, Number(outpost.hp) + 20);
    const newLevel = Number(outpost.level) + 1;
    const upd = await client.query(
      `UPDATE war_outposts
       SET defense = $1, max_hp = $2, hp = $3, level = $4, updated_at = NOW()
       WHERE member_id = $5 RETURNING *`,
      [newDef, newMax, newHp, newLevel, req.member.id]
    );
    await client.query("COMMIT");
    const balance = await getBalance(req.member.id);
    res.json({
      ok: true,
      cost,
      balance,
      outpost: {
        hp: upd.rows[0].hp,
        maxHp: upd.rows[0].max_hp,
        defense: upd.rows[0].defense,
        trophy: upd.rows[0].trophy,
        level: upd.rows[0].level
      },
      message: "Outpost upgraded! Def +" + 5 + " · HP +" + 20
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("WAR UPGRADE:", e);
    res.status(500).json({ ok: false, error: e.message || "upgrade failed" });
  } finally {
    client.release();
  }
});

app.get("/api/war/targets", requireAuth, async (req, res) => {
  try {
    await ensureWarTables();
    await getOrCreateOutpost(req.member.id);
    const rows = await pool.query(
      `SELECT o.member_id, o.hp, o.max_hp, o.defense, o.trophy, o.level, m.username
       FROM war_outposts o
       JOIN members m ON m.id = o.member_id
       WHERE o.member_id <> $1 AND o.hp > 0
       ORDER BY ABS(o.trophy - COALESCE((SELECT trophy FROM war_outposts WHERE member_id = $1), 0)) ASC,
                RANDOM()
       LIMIT 8`,
      [req.member.id]
    );
    // If few outposts, also allow targeting members without outpost (create on raid)
    let list = rows.rows;
    if (list.length < 3) {
      const extra = await pool.query(
        `SELECT m.id AS member_id, m.username,
                100 AS hp, 100 AS max_hp, 10 AS defense, 0 AS trophy, 1 AS level
         FROM members m
         WHERE m.id <> $1
           AND NOT EXISTS (SELECT 1 FROM war_outposts w WHERE w.member_id = m.id)
         ORDER BY RANDOM()
         LIMIT $2`,
        [req.member.id, 5 - list.length]
      );
      list = list.concat(extra.rows);
    }
    res.json({
      ok: true,
      targets: list.map((r) => ({
        memberId: r.member_id,
        username: r.username || ("miner#" + r.member_id),
        hp: r.hp,
        maxHp: r.max_hp,
        defense: r.defense,
        trophy: r.trophy,
        level: r.level
      }))
    });
  } catch (e) {
    console.error("WAR TARGETS:", e);
    res.status(500).json({ ok: false, error: e.message || "targets failed" });
  }
});

app.post("/api/war/raid", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureWarTables();
    const targetId = Number(req.body?.targetId);
    if (!targetId || targetId === Number(req.member.id)) {
      return res.status(400).json({ ok: false, error: "Pick a valid target." });
    }
    await client.query("BEGIN");
    await client.query(`SELECT id FROM members WHERE id = $1 FOR UPDATE`, [req.member.id]);

    const myO = await getOrCreateOutpost(req.member.id, client);
    if (myO.last_raid_at) {
      const left = WAR_RAID_COOLDOWN_MS - (Date.now() - new Date(myO.last_raid_at).getTime());
      if (left > 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          error: "Raid cooldown — wait " + Math.ceil(left / 60000) + " min."
        });
      }
    }

    // lock target member row then outpost
    const tgtMem = await client.query(`SELECT id, username FROM members WHERE id = $1 FOR UPDATE`, [targetId]);
    if (!tgtMem.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Target not found." });
    }
    const defO = await getOrCreateOutpost(targetId, client);

    // Auto battle: attack power from my level/defense, vs their defense
    const atkPower = 15 + Number(myO.level) * 3 + Math.floor(Number(myO.defense) / 4);
    const defPower = 8 + Number(defO.defense);
    let damage = Math.max(5, atkPower - Math.floor(defPower * 0.35) + Math.floor(Math.random() * 10) - 3);
    damage = Math.min(damage, Number(defO.hp));
    const newHp = Math.max(0, Number(defO.hp) - damage);
    const win = damage >= 12 || newHp <= Number(defO.max_hp) * 0.4;

    let loot = 0;
    let atkTrophy = 0;
    let defTrophy = 0;
    if (win) {
      loot = Math.round((0.15 + Math.random() * 0.35) * 100) / 100; // 0.15–0.50 AMT
      atkTrophy = 8 + Math.floor(Math.random() * 5);
      defTrophy = -5;
      await client.query(
        `INSERT INTO amt_ledger (member_id, amount, type, reference)
         VALUES ($1, $2, 'WAR_LOOT', $3)`,
        [req.member.id, loot, makeReference("AMT-WARLOOT")]
      );
    } else {
      atkTrophy = -3;
      defTrophy = 4;
      loot = 0;
    }

    await client.query(
      `UPDATE war_outposts SET hp = $1, trophy = GREATEST(0, trophy + $2), last_defend_at = NOW(), updated_at = NOW()
       WHERE member_id = $3`,
      [newHp, defTrophy, targetId]
    );
    await client.query(
      `UPDATE war_outposts SET trophy = GREATEST(0, trophy + $1), last_raid_at = NOW(), updated_at = NOW()
       WHERE member_id = $2`,
      [atkTrophy, req.member.id]
    );
    // slow HP regen for defender if wiped
    if (newHp === 0) {
      await client.query(
        `UPDATE war_outposts SET hp = GREATEST(20, FLOOR(max_hp * 0.25)) WHERE member_id = $1`,
        [targetId]
      );
    }

    await client.query(
      `INSERT INTO war_attacks
        (attacker_id, defender_id, damage, loot_amt, result, attacker_trophy_delta, defender_trophy_delta)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        req.member.id,
        targetId,
        damage,
        loot,
        win ? "WIN" : "LOSS",
        atkTrophy,
        defTrophy
      ]
    );

    await client.query("COMMIT");
    const balance = await getBalance(req.member.id);
    const myAfter = await getOrCreateOutpost(req.member.id);
    res.json({
      ok: true,
      result: win ? "WIN" : "LOSS",
      damage,
      lootAmt: loot,
      trophyDelta: atkTrophy,
      targetUsername: tgtMem.rows[0].username,
      balance,
      outpost: {
        hp: myAfter.hp,
        maxHp: myAfter.max_hp,
        defense: myAfter.defense,
        trophy: myAfter.trophy,
        level: myAfter.level
      },
      message: win
        ? ("Victory vs @" + (tgtMem.rows[0].username || "miner") + " · +" + loot + " AMT · Trophy " + (atkTrophy >= 0 ? "+" : "") + atkTrophy)
        : ("Raid failed vs @" + (tgtMem.rows[0].username || "miner") + " · Trophy " + atkTrophy)
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("WAR RAID:", e);
    res.status(500).json({ ok: false, error: e.message || "raid failed" });
  } finally {
    client.release();
  }
});

app.post("/api/war/repair", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureWarTables();
    const cost = 1;
    await client.query("BEGIN");
    await client.query(`SELECT id FROM members WHERE id = $1 FOR UPDATE`, [req.member.id]);
    const o = await getOrCreateOutpost(req.member.id, client);
    if (Number(o.hp) >= Number(o.max_hp)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Outpost already full HP." });
    }
    const bal = await getBalance(req.member.id, client);
    if (bal < cost) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Need " + cost + " AMT to repair." });
    }
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference)
       VALUES ($1, $2, 'WAR_REPAIR', $3)`,
      [req.member.id, -cost, makeReference("AMT-WARREP")]
    );
    const healed = Math.min(Number(o.max_hp), Number(o.hp) + 30);
    const upd = await client.query(
      `UPDATE war_outposts SET hp = $1, updated_at = NOW() WHERE member_id = $2 RETURNING *`,
      [healed, req.member.id]
    );
    await client.query("COMMIT");
    res.json({
      ok: true,
      cost,
      outpost: {
        hp: upd.rows[0].hp,
        maxHp: upd.rows[0].max_hp,
        defense: upd.rows[0].defense,
        trophy: upd.rows[0].trophy,
        level: upd.rows[0].level
      },
      message: "Repaired +" + (healed - Number(o.hp)) + " HP"
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("WAR REPAIR:", e);
    res.status(500).json({ ok: false, error: e.message || "repair failed" });
  } finally {
    client.release();
  }
});


    app.listen(PORT, "0.0.0.0", () => {
      console.log("==================================================");
      console.log("AMT MAINNET BACKEND ONLINE");
      console.log("Port: " + PORT);
      console.log("Daily missions + dungeon: ENABLED");
      console.log("==================================================");
    });

  } catch (error) {
    console.error("SERVER START FAILED:", error);
    process.exit(1);
  }
}

startServer();