"use strict";

/*
============================================================
ALBERTO MARKETPLACE TOKEN (AMT)
PI TESTNET BACKEND
FULL SERVER VERSION 2.4.28

IMPORTANT:
- TESTNET ONLY
- AMT application ledger wallet only
- Generated AMT- address is NOT a Pi/Stellar blockchain wallet
- Pi authentication is verified server-side
- Mining rewards are application-ledger accounting
- Airdrop is application-ledger accounting
- AMT transfers are application-ledger accounting
- Staking is application-ledger accounting
- Marketplace payments use Pi Testnet Payments API
- NO MAINNET VALUE IS CLAIMED

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
- Added verified Pi Testnet wallet address to auth response
- Added verified Pi Testnet wallet address to profile response
- Added verified Pi Testnet wallet address to wallet response
- AMT ledger address remains separate from Pi wallet address
- FIXED: Explicitly return referralCode (= username) for every Pioneer
  in /api/auth/verify, /api/profile, /api/wallet, and /api/referral/status
- NEW: Added referral_code column to members table
- NEW: On every login, Pi username is permanently saved as referral_code
- NEW: referralCode is now read from the saved referral_code column
- FIXED: /api/referrals now returns referralCode + activeMiners
  (frontend was calling this endpoint and showing ------)
- NEW: Referral Tier System (Bronze / Silver / Gold / Legend)
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
  process.env.DEV_PI_USERNAMES || process.env.DEV_PI_USERNAME || ""
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

/* 48-hour claim window for NEW 100 AMT airdrop (shared campaign window) */
const AIRDROP_CLAIM_WINDOW_SECONDS =
  48 * 60 * 60;

/* Campaign starts when 100 AMT airdrop went live — all users share this window */
const AIRDROP_CAMPAIGN_START_MS =
  new Date(
    process.env.AIRDROP_CAMPAIGN_START ||
    "2026-09-18T00:00:00.000Z"
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
  { name: "Legend", min: 51, max: Infinity, rewardPerReferral: 2.0 }
];

const REFERRAL_MILESTONES = [
  { count: 5, bonus: 2.0, key: "M5" },
  { count: 15, bonus: 5.0, key: "M15" },
  { count: 50, bonus: 15.0, key: "M50" }
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
  "https://api.testnet.minepi.com";

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
    : undefined
});

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

async function verifyPiAccessToken(
  accessToken
) {
  if (!accessToken) {
    throw new HttpError(
      401,
      "Pi access token is required."
    );
  }

  const response = await fetch(
    `${PI_API_BASE}/v2/me`,
    {
      method: "GET",

      headers: {
        Accept: "application/json",
        Authorization:
          `Bearer ${accessToken}`
      }
    }
  );

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }

  if (
    !response.ok ||
    !data?.uid
  ) {
    throw new HttpError(
      401,
      data?.error ||
        data?.message ||
        "Pi authentication failed."
    );
  }

  return {
    uid: String(data.uid),

    username: cleanUsername(
      data.username
    ),

    /*
     * This is the VERIFIED Pi wallet address
     * returned by the Pi API.
     *
     * It is NOT the AMT- ledger address.
     */
    walletAddress:
      data.wallet_address || null
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
  ).toLowerCase();
  const uid = String((piUser && piUser.uid) || member.pi_uid || "");

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

  const matchUser =
    DEV_PI_USERNAMES.length > 0 && DEV_PI_USERNAMES.includes(uname);
  const matchUid = DEV_PI_UIDS.length > 0 && DEV_PI_UIDS.includes(uid);
  const matchLedger =
    ledgerAddr &&
    DEV_LEDGER_ADDRESSES.length > 0 &&
    DEV_LEDGER_ADDRESSES.includes(ledgerAddr);

  if (!matchUser && !matchUid && !matchLedger) return;

  const exists = await pool.query(
    `SELECT id FROM amt_ledger
     WHERE member_id = $1 AND reference = $2
     LIMIT 1`,
    [member.id, DEV_TREASURY_REF]
  );
  if (exists.rows.length) return;

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

app.get("/", async (req, res) => {
  res.json({
    ok: true,

    service:
      "Alberto Marketplace Token",

    symbol:
      "AMT",

    network:
      "Pi Testnet",

    environment:
      "TESTNET",

    version:
      "2.4.28",

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

async function healthHandler(
  req,
  res
) {
  let db = "OK";

  try {
    await pool.query(
      "SELECT 1"
    );
  } catch {
    db = "ERROR";
  }

  res
    .status(
      db === "OK"
        ? 200
        : 503
    )
    .json({
      ok:
        db === "OK",

      service:
        "AMT Testnet Backend",

      database:
        db,

      piApiKeyConfigured:
        Boolean(
          PI_API_KEY
        ),

      network:
        "Pi Testnet",

      environment:
        "TESTNET",

      staking:
        true,

      timestamp:
        nowIso()
    });
}

app.get(
  "/health",
  healthHandler
);

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
            "AMT_TESTNET_LEDGER"
        },

        network:
          "Pi Testnet",

        environment:
          "TESTNET",

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
        "AMT_TESTNET_LEDGER",

      isBlockchainWallet:
        false,

      network:
        "Pi Testnet",

      environment:
        "TESTNET",

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
        "Pi Testnet",

      environment:
        "TESTNET",

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
        "AMT_TESTNET_LEDGER",

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
ON-CHAIN BALANCES (Pi Testnet Horizon — own wallet only)
========================================================= */

const PI_HORIZON_BASE =
  process.env.PI_HORIZON_BASE ||
  "https://api.testnet.minepi.com";

const PI_HORIZON_BASE_2 =
  process.env.PI_HORIZON_BASE_2 ||
  "https://api.testnet2.minepi.com";

async function fetchHorizonAccount(address) {
  const urls = [
    `${PI_HORIZON_BASE}/accounts/${encodeURIComponent(address)}`,
    `${PI_HORIZON_BASE_2}/accounts/${encodeURIComponent(address)}`
  ];

  let lastError = null;

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" }
      });

      if (response.status === 404) {
        return { exists: false, balances: [] };
      }

      if (!response.ok) {
        lastError = new Error(`Horizon ${response.status}`);
        continue;
      }

      const data = await response.json();
      return {
        exists: true,
        balances: Array.isArray(data.balances) ? data.balances : [],
        horizon: url.includes("testnet2") ? "testnet2" : "testnet"
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Horizon unavailable");
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
            "Link your Pi Testnet wallet first to see on-chain balances."
        });
      }

      const account = await fetchHorizonAccount(address);

      if (!account.exists) {
        return res.json({
          ok: true,
          linked: true,
          piWalletAddress: address,
          accountExists: false,
          testPiBalance: 0,
          onchainAmtBalance: 0,
          otherTokens: [],
          message:
            "Account not found on Pi Testnet yet (or not activated)."
        });
      }

      let testPiBalance = 0;
      let onchainAmtBalance = 0;
      const otherTokens = [];

      for (const b of account.balances) {
        const amount = Number(b.balance || 0);

        if (b.asset_type === "native") {
          testPiBalance = amount;
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

      res.json({
        ok: true,
        linked: true,
        accountExists: true,
        piWalletAddress: address,
        testPiBalance,
        onchainAmtBalance,
        otherTokens,
        horizon: account.horizon || "testnet",
        network: "Pi Testnet"
      });
    } catch (error) {
      console.error("ONCHAIN BALANCE ERROR:", error);
      res.status(500).json({
        ok: false,
        error:
          "Unable to fetch on-chain balances from Pi Testnet."
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
        network: "Pi Testnet",
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
            "Transaction not found on Pi Testnet. Check hash and network."
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

    const recipientWallet =
      await client.query(
        `
        SELECT
          id,
          member_id,
          wallet_address
        FROM amt_wallets
        WHERE
          UPPER(wallet_address) = $1
        LIMIT 1
        FOR UPDATE
        `,
        [recipientAddress]
      );

    if (
      !recipientWallet.rows.length
    ) {
      throw new HttpError(
        404,
        "Recipient AMT ledger address was not found."
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
          "Pi Testnet",
        walletType:
          "AMT_TESTNET_LEDGER"
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
    const result =
      await pool.query(
        `
        SELECT

          t.tx_id,
          t.amount,
          t.memo,
          t.status,
          t.created_at,

          sw.wallet_address
            AS sender_address,

          rw.wallet_address
            AS recipient_address

        FROM amt_transfers t

        JOIN amt_wallets sw
          ON sw.member_id =
             t.sender_member_id

        JOIN amt_wallets rw
          ON rw.member_id =
             t.recipient_member_id

        WHERE
          t.sender_member_id = $1
          OR
          t.recipient_member_id = $1

        ORDER BY
          t.created_at DESC

        LIMIT 50
        `,
        [req.member.id]
      );

    const transactions =
      result.rows.map(
        row => ({
          txId:
            row.tx_id,

          amount:
            Number(row.amount),

          memo:
            row.memo,

          status:
            row.status,

          createdAt:
            row.created_at,

          direction:
            row.sender_address ===
            req.wallet.wallet_address
              ? "SEND"
              : "RECEIVE",

          senderAddress:
            row.sender_address,

          recipientAddress:
            row.recipient_address
        })
      );

    res.json({
      ok: true,
      transactions
    });
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
        "Pi Testnet",

      type:
        "ONE_TIME_TESTNET_AIRDROP_48H",

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
              "Airdrop claim window has expired (48 hours).",
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
          "Pi Testnet"
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

    const last = await pool.query(
      `SELECT claim_date, amount, streak, created_at
       FROM daily_rewards
       WHERE member_id = $1
       ORDER BY claim_date DESC
       LIMIT 1`,
      [req.member.id]
    );

    let streak = 0;
    let claimedToday = false;
    let lastClaimDate = null;
    let lastAmount = null;

    if (last.rows.length) {
      const row = last.rows[0];
      lastClaimDate = String(row.claim_date).slice(0, 10);
      lastAmount = Number(row.amount);
      if (lastClaimDate === today) {
        claimedToday = true;
        streak = Number(row.streak) || 1;
      } else if (lastClaimDate === yesterday) {
        streak = Number(row.streak) || 1;
      } else {
        streak = 0;
      }
    }

    const nextStreak = claimedToday
      ? streak
      : Math.min(DAILY_MAX_STREAK, (streak || 0) + 1);
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

    let streak = 1;
    if (last.rows.length) {
      const lastDate = String(last.rows[0].claim_date).slice(0, 10);
      if (lastDate === yesterday) {
        streak = Math.min(DAILY_MAX_STREAK, (Number(last.rows[0].streak) || 1) + 1);
      }
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
        "Pi Testnet",

      environment:
        "TESTNET",

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
          "Pi Testnet",

        environment:
          "TESTNET",

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
          "Pi Testnet",

        environment:
          "TESTNET"
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

      if (
        Date.now() <
        unlockTime
      ) {
        throw new HttpError(
          400,
          "Stake is still locked.",
          {
            unlockAt:
              stake.unlock_at,

            remainingSeconds:
              Math.ceil(
                (
                  unlockTime -
                  Date.now()
                ) / 1000
              )
          }
        );
      }

      const principal =
        Number(
          stake.principal
        );

      const reward =
        Number(
          stake.reward_amount
        );

      const total =
        Number(
          (
            principal +
            reward
          ).toFixed(8)
        );

      const reference =
        makeReference(
          "AMT-UNSTAKE"
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
            'STAKING_PAYOUT',
            $3
          )
        `,
        [
          req.member.id,
          total,
          reference
        ]
      );

      await client.query(
        `
        UPDATE amt_stakes
        SET
          status = 'COMPLETED',
          unstaked_at = NOW()
        WHERE id = $1
        `,
        [stakeId]
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

        stakeId,

        principal,

        reward,

        total,

        reference,

        balance,

        status:
          "COMPLETED",

        network:
          "Pi Testnet",

        environment:
          "TESTNET"
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
          "Pi Testnet",

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
  "Earth", "Water", "Nature", "Ice", "Fire", "Wind", "Thunder"
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
function rarityFromLevel(level) {
  const lv = Math.max(1, Number(level) || 1);
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
  { level: 50, amount: 15, key: "LV50" }
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
  // Multi level-up if lots of exp
  while (exp >= level * 50 && level < 99) {
    exp -= level * 50;
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
];


function getPetById(petId) {
  return AMT_PETS.find(p => p.id === petId) || null;
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
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS happiness INT NOT NULL DEFAULT 100`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS is_listed BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS image TEXT`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS level INT NOT NULL DEFAULT 1`,
    `ALTER TABLE owned_pets ADD COLUMN IF NOT EXISTS exp INT NOT NULL DEFAULT 0`,
    `ALTER TABLE pet_eggs ADD COLUMN IF NOT EXISTS is_listed BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE pet_eggs ADD COLUMN IF NOT EXISTS gen INT NOT NULL DEFAULT 1`,
    `ALTER TABLE pet_listings ADD COLUMN IF NOT EXISTS egg_id BIGINT`,
    `ALTER TABLE pet_listings ADD COLUMN IF NOT EXISTS listing_type TEXT DEFAULT 'PET'`,
    `ALTER TABLE pet_listings ALTER COLUMN owned_pet_id DROP NOT NULL`
  ];
  for (const q of alts) {
    try {
      await pool.query(q);
    } catch (e) {
      /* ignore */
    }
  }
}

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

function dailyAmountForStreak(streak) {
  const s = Math.max(1, Math.min(DAILY_MAX_STREAK, Number(streak) || 1));
  return DAILY_REWARD_AMOUNTS[s - 1];
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
app.get("/api/pets/owned", requireAuth, async (req, res) => {
  try {
    await ensurePetTables();
    const result = await pool.query(
      `SELECT * FROM owned_pets WHERE member_id = $1 ORDER BY id DESC`,
      [req.member.id]
    );
    res.json({
      ok: true,
      count: result.rows.length,
      memberId: req.member.id,
      pets: result.rows
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
        (member_id, pet_id, name, element, rarity, hp, atk, def, spd, ability, image)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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
        pet.image
      ]
    );
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
app.post("/api/pets/care", requireAuth, async (req, res) => {
  const ownedId = Number(req.body?.ownedPetId);
  const action = String(req.body?.action || "feed").toLowerCase(); // feed | play
  if (!Number.isFinite(ownedId) || ownedId < 1) {
    return res.status(400).json({ ok: false, error: "ownedPetId required." });
  }

  const cost = action === "play" ? 0.1 : 0.2;
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
      return res.status(404).json({
        ok: false,
        error: "Pet not found in your My Pets. Buy again or re-open My Pets."
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
    const energyGain = action === "feed" ? 30 : 15;
    const happyGain = action === "play" ? 30 : 15;
    const updated = await client.query(
      `UPDATE owned_pets SET
        energy = LEAST(100, COALESCE(energy, 0) + $1),
        happiness = LEAST(100, COALESCE(happiness, 0) + $2)
       WHERE id = $3 RETURNING *`,
      [energyGain, happyGain, ownedId]
    );
    await client.query("COMMIT");
    res.json({ ok: true, action, cost, pet: updated.rows[0] });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("CARE ERROR:", e);
    res.status(500).json({
      ok: false,
      error: "Care failed. " + (e.message || "")
    });
  } finally {
    client.release();
  }
});

/* ---------- Training ---------- */
app.post("/api/pets/train", requireAuth, async (req, res) => {
  const ownedId = Number(req.body?.ownedPetId);
  const stat = String(req.body?.stat || "atk").toLowerCase(); // hp|atk|def|spd
  if (!Number.isFinite(ownedId) || ownedId < 1) {
    return res.status(400).json({ ok: false, error: "ownedPetId required." });
  }
  if (!["hp", "atk", "def", "spd"].includes(stat)) {
    return res.status(400).json({ ok: false, error: "Invalid stat." });
  }

  const cost = 0.5;
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
      return res.status(404).json({
        ok: false,
        error: "Pet not found in your My Pets."
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
        error: "Insufficient in-app AMT. Need 0.5 (you have " + balance + ")."
      });
    }
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'PET_TRAIN',$3)`,
      [req.member.id, -cost, makeReference("AMT-TRAIN")]
    );
    const gain = stat === "hp" ? 5 : 2;
    // Stat + energy + exp (level/rarity resolved below)
    await client.query(
      `UPDATE owned_pets SET
        ${stat} = COALESCE(${stat}, 0) + $1,
        energy = GREATEST(0, COALESCE(energy, 0) - 20),
        exp = COALESCE(exp, 0) + 10
       WHERE id = $2`,
      [gain, ownedId]
    );
    const petAfter = await applyLevelAndRarity(
      client,
      ownedId,
      req.member.id
    );
    await client.query("COMMIT");
    res.json({
      ok: true,
      trained: stat,
      gain,
      cost,
      pet: petAfter,
      rarity: petAfter && petAfter.rarity,
      level: petAfter && petAfter.level,
      milestones: (petAfter && petAfter._milestones) || []
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("TRAIN ERROR:", e);
    res.status(500).json({
      ok: false,
      error: "Training failed. " + (e.message || "")
    });
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
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'EGG_SALE',$3)`,
      [L.seller_member_id, price, makeReference("AMT-EGG-SALE")]
    );
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'EGG_BUY',$3)`,
      [req.member.id, -price, makeReference("AMT-EGG-BUY")]
    );
    await client.query(
      `UPDATE pet_eggs SET member_id = $1, is_listed = FALSE WHERE id = $2`,
      [req.member.id, L.egg_id]
    );
    await client.query(
      `UPDATE egg_listings SET status = 'SOLD' WHERE id = $1`,
      [listingId]
    );
    await client.query("COMMIT");
    res.json({
      ok: true,
      purchased: true,
      price,
      eggId: L.egg_id,
      message: "Egg purchased — check Baby Room (Eggs tab)"
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("BUY EGG:", e);
    res.status(500).json({ ok: false, error: "Buy egg failed. " + (e.message || "") });
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

/* ---------- Buy from public sell ---------- */
app.post("/api/pets/buy-listing", requireAuth, async (req, res) => {
  const listingId = Number(req.body?.listingId);
  if (!Number.isInteger(listingId)) return res.status(400).json({ ok: false, error: "listingId required." });

  const client = await pool.connect();
  try {
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
    const price = Number(L.price_amt);
    const balance = await getBalance(req.member.id, client);
    if (balance < price) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Insufficient AMT." });
    }
    // Pay seller
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'PET_SALE',$3)`,
      [L.seller_member_id, price, makeReference("AMT-SALE")]
    );
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'PET_BUY_LISTING',$3)`,
      [req.member.id, -price, makeReference("AMT-BUY")]
    );
    // Transfer ownership
    await client.query(
      `UPDATE owned_pets SET member_id = $1, is_listed = FALSE WHERE id = $2`,
      [req.member.id, L.owned_pet_id]
    );
    await client.query(
      `UPDATE pet_listings SET status = 'SOLD' WHERE id = $1`,
      [listingId]
    );
    await client.query("COMMIT");
    res.json({ ok: true, purchased: true, price });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("BUY LISTING ERROR:", e);
    res.status(500).json({ ok: false, error: "Purchase failed." });
  } finally {
    client.release();
  }
});

/* ---------- Battle (simple PvE) ---------- */
app.post("/api/pets/battle", requireAuth, async (req, res) => {
  const ownedId = Number(req.body?.ownedPetId);
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
      return res.status(404).json({ ok: false, error: "Pet not found in My Pets." });
    }
    const pet = petRes.rows[0];
    if (Number(pet.energy) < 15) {
      return res.status(400).json({
        ok: false,
        error: "Pet needs energy. Care first."
      });
    }

    // Opponent = random catalog pet (real uploaded art), not generic emoji
    let foePool = AMT_PETS.filter(
      p => p.id !== pet.pet_id && p.name !== pet.name
    );
    if (!foePool.length) foePool = AMT_PETS.slice();
    const wild = foePool[Math.floor(Math.random() * foePool.length)] || AMT_PETS[0];
    const opp = {
      name: "Wild " + wild.name,
      element: wild.element,
      image: wild.image || null,
      petId: wild.id,
      base: Math.round(
        (Number(wild.hp) || 40) * 0.55 + Math.floor(Math.random() * 15)
      )
    };

    let myHp = Number(pet.hp) + Number(pet.level) * 8;
    let enHp =
      opp.base + Math.floor(Math.random() * 20) + Number(pet.level) * 5;
    const myMax = myHp;
    const enMax = enHp;
    const myAtk = Number(pet.atk) + Number(pet.level) * 2;
    const myDef = Number(pet.def);
    const mySpd = Number(pet.spd);
    const enAtk =
      Math.round((Number(wild.atk) || 10) * 0.7) +
      Math.floor(Math.random() * 8) +
      Number(pet.level);
    const enDef =
      Math.round((Number(wild.def) || 8) * 0.6) +
      Math.floor(Math.random() * 6);

    const rounds = [];
    let round = 0;
    const maxRounds = 6;
    while (myHp > 0 && enHp > 0 && round < maxRounds) {
      round += 1;
      const myFirst = mySpd + Math.random() * 10 >= enAtk * 0.3 + Math.random() * 10;
      if (myFirst) {
        const dmg = Math.max(3, Math.round(myAtk - enDef * 0.4 + Math.random() * 6));
        enHp = Math.max(0, enHp - dmg);
        rounds.push({
          round,
          actor: "you",
          dmg,
          myHp,
          enHp,
          text: pet.name + " hits " + opp.name + " for " + dmg
        });
        if (enHp <= 0) break;
        const edmg = Math.max(2, Math.round(enAtk - myDef * 0.35 + Math.random() * 5));
        myHp = Math.max(0, myHp - edmg);
        rounds.push({
          round,
          actor: "enemy",
          dmg: edmg,
          myHp,
          enHp,
          text: opp.name + " hits for " + edmg
        });
      } else {
        const edmg = Math.max(2, Math.round(enAtk - myDef * 0.35 + Math.random() * 5));
        myHp = Math.max(0, myHp - edmg);
        rounds.push({
          round,
          actor: "enemy",
          dmg: edmg,
          myHp,
          enHp,
          text: opp.name + " hits for " + edmg
        });
        if (myHp <= 0) break;
        const dmg = Math.max(3, Math.round(myAtk - enDef * 0.4 + Math.random() * 6));
        enHp = Math.max(0, enHp - dmg);
        rounds.push({
          round,
          actor: "you",
          dmg,
          myHp,
          enHp,
          text: pet.name + " hits " + opp.name + " for " + dmg
        });
      }
    }

    const win = enHp <= 0 || (myHp > 0 && myHp >= enHp);
    const reward = win ? 0.3 : 0.05;

    await client.query(
      `UPDATE owned_pets SET energy = GREATEST(0, energy - 15),
        exp = COALESCE(exp, 0) + $1 WHERE id = $2`,
      [win ? 25 : 8, ownedId]
    );
    const petAfterBattle = await applyLevelAndRarity(
      client,
      ownedId,
      req.member.id
    );
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference)
       VALUES ($1,$2,'PET_BATTLE',$3)`,
      [req.member.id, reward, makeReference("AMT-BATTLE")]
    );
    await client.query(
      `INSERT INTO pet_battles
        (member_id, owned_pet_id, opponent_name, result, reward_amt)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.member.id, ownedId, opp.name, win ? "WIN" : "LOSS", reward]
    );

    res.json({
      ok: true,
      result: win ? "WIN" : "LOSS",
      petLevel: petAfterBattle && petAfterBattle.level,
      petRarity: petAfterBattle && petAfterBattle.rarity,
      petExp: petAfterBattle && petAfterBattle.exp,
      milestones: (petAfterBattle && petAfterBattle._milestones) || [],
      opponent: opp.name,
      opponentElement: opp.element,
      opponentImage: opp.image,
      opponentPetId: opp.petId,
      // Legacy emoji fallback (UI prefers image)
      opponentEmoji:
        ({
          Earth: "🌍",
          Water: "💧",
          Nature: "🌿",
          Ice: "❄️",
          Fire: "🔥",
          Wind: "🌬️",
          Thunder: "⚡"
        }[opp.element] || "🐾"),
      petName: pet.name,
      petElement: pet.element,
      petImage: pet.image,
      myMaxHp: myMax,
      enMaxHp: enMax,
      myFinalHp: myHp,
      enFinalHp: enHp,
      rounds,
      reward,
      energyLeft: Math.max(0, Number(pet.energy) - 15)
    });
  } catch (e) {
    console.error("BATTLE ERROR:", e);
    res.status(500).json({ ok: false, error: "Battle failed. " + (e.message || "") });
  } finally {
    client.release();
  }
});

/* Catalog detail — MUST stay after /owned /eggs /listings */
app.get("/api/pets/:petId", async (req, res) => {
  const reserved = ["owned", "eggs", "listings", "buy", "care", "train", "breed", "hatch", "list", "battle"];
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
          "Pi Testnet",

        environment:
          "TESTNET"
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

      if (
        productId !==
        MARKET_TEST_PRODUCT_ID
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Invalid test product."
          });
      }

      if (
        !Number.isFinite(amount) ||
        amount !==
          MARKET_TEST_PRICE_PI
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Invalid test price."
          });
      }

      const payment =
        await piPaymentRequest(
          `/v2/payments/${encodeURIComponent(
            paymentId
          )}`,
          "GET"
        );

      if (
        Number(
          payment.amount
        ) !==
        MARKET_TEST_PRICE_PI
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Payment amount does not match test product."
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
            productId,
            amount
          ]
        );

      res.json({
        ok: true,

        approved:
          true,

        payment:
          saved.rows[0]
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

      if (
        payment.product_id !==
        MARKET_TEST_PRODUCT_ID
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Invalid marketplace product."
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
            "Pi Testnet"
        });
      }

      await piPaymentRequest(
        `/v2/payments/${encodeURIComponent(
          paymentId
        )}/complete`,
        "POST"
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

      await client.query(
        "COMMIT"
      );

      res.json({
        ok: true,

        completed:
          true,

        paymentId,

        productId:
          payment.product_id,

        network:
          "Pi Testnet"
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
          "Pi Testnet",

        environment:
          "TESTNET",

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
          "Pi Testnet",

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
          "Pi Testnet",

        walletType:
          "AMT_TESTNET_LEDGER"
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
START SERVER
========================================================= */

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          "=================================================="
        );

        console.log(
          "AMT TESTNET BACKEND ONLINE"
        );

        console.log(
          `Port: ${PORT}`
        );

        console.log(
          "Environment: TESTNET"
        );

        console.log(
          "Network: Pi Testnet"
        );

        console.log(
          "Version: 2.4.28"
        );

        console.log(
          `Mining rate: ${AMT_MINING_RATE} AMT/hour`
        );

        console.log(
          `Airdrop: ${AIRDROP_AMOUNT_AMT} AMT (48h claim window)`
        );

        console.log(
          "Staking: ENABLED"
        );

        console.log(
          "30D: 5%"
        );

        console.log(
          "90D: 10%"
        );

        console.log(
          "180D: 15%"
        );

        console.log(
          "Legacy login compatibility: ENABLED"
        );

        console.log(
          "Pi wallet address response: ENABLED"
        );

        console.log(
          "=================================================="
        );
      }
    );

  } catch (error) {
    console.error(
      "SERVER START FAILED:",
      error
    );

    process.exit(1);
  }
}

startServer();