# ELO Rating Services Documentation

This repository contains **two separate ELO rating implementations** serving different purposes:

## 1. EloRatingService (`src/services/EloRatingService.ts`)

**Purpose:** Simple, fast ELO rating for real-time swipe events with smoothing for user-facing display.

**Features:**
- Classic ELO algorithm with dynamic K-factor (40/20/10)
- Exponential Moving Average (EMA) smoothing for displayed ratings
- Rating history tracking with configurable limit (500 points)
- Privacy-aware display (respects `UserWellbeingSettings`)
- Draw outcome (S=0.5) for viewer on skip to prevent inflation

**Use Cases:**
- WebSocket swipe events (`/elo/swipe` endpoint)
- Real-time rating updates during active sessions
- User-facing rating display with anxiety reduction

**Key Methods:**
- `processSwipe(viewerId, subjectId, outcome)` - Process a single swipe
- `getDisplayRating(userId)` - Get smoothed rating for UI
- `getRatingHistory(userId, sinceMs?)` - Get rating timeline

## 2. EloService (`src/services/EloService.ts`)

**Purpose:** Full Glicko-2 rating system for accurate skill assessment with uncertainty modeling.

**Features:**
- Complete Glicko-2 implementation (rating + deviation + volatility)
- Batch processing (1000+ updates/second)
- Rating floor enforcement (800 minimum)
- Dynamic K-factor compatibility layer
- Pluggable storage (in-memory or Redis)

**Use Cases:**
- REST API swipe events (`/api/swipe` endpoint)
- Batch rating updates and recalculations
- Matchmaking queue (bracket-based matching)
- Long-term skill assessment

**Key Methods:**
- `update(userId, outcomes)` - Apply Glicko-2 update for single user
- `headToHead(userIdA, userIdB, scoreA)` - Symmetric two-player update
- `processBatch(maxUpdates)` - Drain batch queue

## When to Use Which Service

### Use **EloRatingService** when:
- Processing real-time WebSocket swipe events
- Need to display ratings to users (with smoothing)
- Want simple, predictable rating changes
- Rating history visualization is required

### Use **EloService** when:
- Building matchmaking queues (needs rating deviation)
- Performing batch rating recalculations
- Need scientific accuracy for skill assessment
- Want to model rating uncertainty over time

## Server Integration

Both services are instantiated in `src/server.ts`:

```typescript
// Line 48: Simple ELO for swipe events
const eloService = new EloRatingService(wellbeingSettings);

// Line 110: Glicko-2 for matchmaking
const glickoService = new EloService();
```

### WebSocket Flow (uses EloRatingService)
1. Client sends `{ type: 'swipe', ... }`
2. Server calls `eloService.processSwipe()`
3. Returns smoothed rating in response

### REST Flow (uses EloService/Glicko)
1. Client POSTs to `/api/swipe`
2. Server calls `swipeProcessor.process()` → `glickoService.headToHead()`
3. Returns full Glicko-2 state

## Migration Path

If you need to consolidate:

**Option A:** Keep both, clarify boundaries
- EloRatingService: UI/UX layer only
- EloService: Source of truth for matchmaking

**Option B:** Unify on Glicko-2
- Add smoothing to EloService
- Migrate WebSocket flow to use Glicko
- Deprecate EloRatingService

**Option C:** Unify on Simple ELO
- Remove rating deviation from matchmaking
- Deprecate EloService
- Accept reduced accuracy for simplicity

## Testing

Both services have comprehensive test coverage:
- `test/EloRatingService.test.ts` - 14 test cases
- `test/EloService.test.ts` - 8 test cases

Run tests: `npm test`
