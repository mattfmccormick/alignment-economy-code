import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { PRECISION, DAILY_SUPPORTIVE_POINTS, DAILY_AMBIENT_POINTS, DAILY_ACTIVE_POINTS } from '../src/core/constants.js';
import { registerProduct, getProduct } from '../src/tagging/products.js';
import { registerSpace, getSpaceAncestors } from '../src/tagging/spaces.js';
import { submitSupportiveTags, getSupportiveTags, finalizeSupportiveTags } from '../src/tagging/supportive.js';
import { submitAmbientTags, finalizeAmbientTags, distributeAmbientThroughHierarchy } from '../src/tagging/ambient.js';
import {
  createSmartContract,
  executeContracts,
  overrideContract,
  resetDailyOverrides,
} from '../src/tagging/smart-contracts.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

function pts(n: number): bigint {
  return BigInt(Math.round(n * Number(PRECISION)));
}

describe('Phase 6: Tagging System', () => {

  // Test 1: Supportive tagging with time-weighted allocation
  it('allocates supportive points by time-weighted formula to manufacturers', () => {
    const db = freshDb();

    // Participant
    const user = createAccount(db, 'individual', 1, 100);
    updateBalance(db, user.account.id, 'supportive_balance', DAILY_SUPPORTIVE_POINTS);

    // Manufacturers (entity accounts)
    const deskMfg = createAccount(db, 'company', 1, 0);
    const laptopMfg = createAccount(db, 'company', 1, 0);
    const shoeMfg = createAccount(db, 'company', 1, 0);

    // Register products
    const desk = registerProduct(db, 'Standing Desk', 'furniture', user.account.id, deskMfg.account.id);
    const laptop = registerProduct(db, 'Laptop', 'electronics', user.account.id, laptopMfg.account.id);
    const shoes = registerProduct(db, 'Running Shoes', 'footwear', user.account.id, shoeMfg.account.id);

    // Submit tags: desk 240min, laptop 240min, shoes 480min = 960 total
    // (Under the 1,440-minute daily cap. Proportions preserved: 1:1:2.)
    const tags = submitSupportiveTags(db, user.account.id, 1, [
      { productId: desk.id, minutesUsed: 240 },
      { productId: laptop.id, minutesUsed: 240 },
      { productId: shoes.id, minutesUsed: 480 },
    ]);

    assert.equal(tags.length, 3);

    // desk:  240/960 = 25% of 14,400,000,000 = 3,600,000,000
    // laptop:240/960 = 25% = 3,600,000,000
    // shoes: 480/960 = 50% = 7,200,000,000
    const totalAllocated = tags.reduce((s, t) => s + t.pointsAllocated, 0n);
    assert.equal(totalAllocated, DAILY_SUPPORTIVE_POINTS);

    const deskTag = tags.find(t => t.productId === desk.id)!;
    const shoeTag = tags.find(t => t.productId === shoes.id)!;
    assert.equal(shoeTag.pointsAllocated, deskTag.pointsAllocated * 2n);

    // Finalize: verify manufacturers receive points (minus 0.5% fee)
    const result = finalizeSupportiveTags(db, user.account.id, 1);
    assert.ok(result.transferred > 0n);
    assert.equal(result.burned, 0n); // all products have manufacturers

    // Check manufacturer balances
    const deskMfgAfter = getAccount(db, deskMfg.account.id)!;
    assert.ok(deskMfgAfter.earnedBalance > 0n, 'Desk manufacturer should have earned points');

    // User supportive balance should be 0
    const userAfter = getAccount(db, user.account.id)!;
    assert.equal(userAfter.supportiveBalance, 0n);

    db.close();
  });

  // Test 2: Ambient tagging with hierarchy
  it('distributes ambient points through space hierarchy with collection rates', () => {
    const db = freshDb();

    const user = createAccount(db, 'individual', 1, 100);
    updateBalance(db, user.account.id, 'ambient_balance', DAILY_AMBIENT_POINTS);

    // Create hierarchy: nation → state → city → building → room
    const nationEntity = createAccount(db, 'company', 1, 0);
    const stateEntity = createAccount(db, 'company', 1, 0);
    const cityEntity = createAccount(db, 'company', 1, 0);
    const buildingEntity = createAccount(db, 'company', 1, 0);

    const nation = registerSpace(db, 'United States', 'nation', undefined, nationEntity.account.id, 5);
    const state = registerSpace(db, 'Colorado', 'state', nation.id, stateEntity.account.id, 8);
    const city = registerSpace(db, 'Denver', 'city', state.id, cityEntity.account.id, 10);
    const building = registerSpace(db, '123 Main St', 'building', city.id, buildingEntity.account.id, 30);
    const room = registerSpace(db, 'Apt 4B', 'room', building.id); // no entity, no collection rate

    // Verify ancestor chain
    const ancestors = getSpaceAncestors(db, room.id);
    assert.equal(ancestors.length, 4);
    assert.equal(ancestors[0].id, building.id);
    assert.equal(ancestors[3].id, nation.id);

    // Test distribution through hierarchy
    const dist = distributeAmbientThroughHierarchy(db, room.id, DAILY_AMBIENT_POINTS);
    assert.ok(dist.length >= 2, 'Should have distributions for room and ancestors');

    // Room gets full amount, building takes 30% of that, city takes 10% of building's take, etc.
    const roomDist = dist.find(d => d.spaceId === room.id)!;
    assert.equal(roomDist.amount, DAILY_AMBIENT_POINTS);

    const buildingDist = dist.find(d => d.spaceId === building.id)!;
    const expectedBuilding = (DAILY_AMBIENT_POINTS * 3000n) / 10000n; // 30%
    assert.equal(buildingDist.amount, expectedBuilding);

    const cityDist = dist.find(d => d.spaceId === city.id)!;
    const expectedCity = (expectedBuilding * 1000n) / 10000n; // 10% of building's take
    assert.equal(cityDist.amount, expectedCity);

    // Submit ambient tags and finalize
    submitAmbientTags(db, user.account.id, 1, [{ spaceId: room.id, minutesOccupied: 1440 }]);
    const result = finalizeAmbientTags(db, user.account.id, 1);

    // Building entity should have received points (room has no entity)
    const buildingAfter = getAccount(db, buildingEntity.account.id)!;
    assert.ok(buildingAfter.earnedBalance > 0n, 'Building entity should earn points');

    const cityAfter = getAccount(db, cityEntity.account.id)!;
    assert.ok(cityAfter.earnedBalance > 0n, 'City entity should earn points');

    // User ambient balance should be 0
    const userAfter = getAccount(db, user.account.id)!;
    assert.equal(userAfter.ambientBalance, 0n);

    db.close();
  });

  // Test 3: Smart contract - supportive auto
  it('auto-creates supportive tags on weekdays, skips weekends', () => {
    const db = freshDb();

    const user = createAccount(db, 'individual', 1, 100);
    updateBalance(db, user.account.id, 'supportive_balance', DAILY_SUPPORTIVE_POINTS);

    const mfg = createAccount(db, 'company', 1, 0);
    const desk = registerProduct(db, 'Desk', 'furniture', user.account.id, mfg.account.id);

    // Create contract: desk, 50%, weekdays 9am-5pm
    const contract = createSmartContract(
      db, user.account.id, 'supportive_auto', desk.id, 50,
      'weekday', 540, 1020,
    );

    // Execute on a weekday (Monday = 1)
    const weekdayResult = executeContracts(db, user.account.id, 1, 1);
    assert.equal(weekdayResult.length, 1);
    assert.equal(weekdayResult[0].executed, true);

    // Verify tag was created
    const tags = getSupportiveTags(db, user.account.id, 1);
    assert.equal(tags.length, 1);
    assert.equal(tags[0].productId, desk.id);

    // Execute on a weekend (Saturday = 6)
    const weekendResult = executeContracts(db, user.account.id, 2, 6);
    assert.equal(weekendResult.length, 1);
    assert.equal(weekendResult[0].executed, false);
    assert.equal(weekendResult[0].reason, 'not scheduled');

    db.close();
  });

  // Test 4: Smart contract - active standing
  it('auto-sends active points to spouse daily', () => {
    const db = freshDb();

    const user = createAccount(db, 'individual', 1, 100);
    updateBalance(db, user.account.id, 'active_balance', DAILY_ACTIVE_POINTS);

    const spouse = createAccount(db, 'individual', 1, 100);

    // Send 100% of active to spouse daily
    createSmartContract(db, user.account.id, 'active_standing', spouse.account.id, 100, 'daily');

    const results = executeContracts(db, user.account.id, 1, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].executed, true);

    // Spouse should have received points (minus fee)
    const spouseAfter = getAccount(db, spouse.account.id)!;
    assert.ok(spouseAfter.earnedBalance > 0n, 'Spouse should receive active points');

    // User active balance should be 0
    const userAfter = getAccount(db, user.account.id)!;
    assert.equal(userAfter.activeBalance, 0n);

    // Verify fee was deducted: spouse gets 99.5% of DAILY_ACTIVE_POINTS
    const expectedNet = DAILY_ACTIVE_POINTS - (DAILY_ACTIVE_POINTS * 50n / 10000n);
    assert.equal(spouseAfter.earnedBalance, expectedNet);

    db.close();
  });

  // Test 5: Override stops auto-execution, resets next day
  it('override blocks contract execution, resets next day', () => {
    const db = freshDb();

    const user = createAccount(db, 'individual', 1, 100);
    updateBalance(db, user.account.id, 'active_balance', DAILY_ACTIVE_POINTS);

    const recipient = createAccount(db, 'individual', 1, 100);
    const contract = createSmartContract(db, user.account.id, 'active_standing', recipient.account.id, 100, 'daily');

    // Override the contract
    overrideContract(db, contract.id);

    // Execute: should NOT run
    const results = executeContracts(db, user.account.id, 1, 1);
    assert.equal(results[0].executed, false);
    assert.equal(results[0].reason, 'overridden');

    const recipientAfter = getAccount(db, recipient.account.id)!;
    assert.equal(recipientAfter.earnedBalance, 0n, 'Recipient should not receive points when overridden');

    // Reset overrides (simulating new day)
    resetDailyOverrides(db);

    // Re-mint active balance for new day
    updateBalance(db, user.account.id, 'active_balance', DAILY_ACTIVE_POINTS);

    // Execute again: should run
    const results2 = executeContracts(db, user.account.id, 2, 2);
    assert.equal(results2[0].executed, true);

    const recipientDay2 = getAccount(db, recipient.account.id)!;
    assert.ok(recipientDay2.earnedBalance > 0n, 'Recipient should receive after override resets');

    db.close();
  });

  // Test 6: Unlinked products burn points
  it('burns supportive points for products with no manufacturer', () => {
    const db = freshDb();

    const user = createAccount(db, 'individual', 1, 100);
    updateBalance(db, user.account.id, 'supportive_balance', DAILY_SUPPORTIVE_POINTS);

    // Product with no manufacturer
    const product = registerProduct(db, 'Homemade Chair', 'furniture', user.account.id);

    submitSupportiveTags(db, user.account.id, 1, [{ productId: product.id, minutesUsed: 1440 }]);
    const result = finalizeSupportiveTags(db, user.account.id, 1);

    assert.equal(result.transferred, 0n, 'Nothing should be transferred');
    assert.ok(result.burned > 0n, 'Points should be burned');
    assert.equal(result.fees, 0n, 'No fees on burned points');

    const userAfter = getAccount(db, user.account.id)!;
    assert.equal(userAfter.supportiveBalance, 0n, 'All supportive balance should be gone');

    db.close();
  });

  // Test 7: Tag updates recalculate correctly
  it('recalculates allocation when tags are updated mid-day', () => {
    const db = freshDb();

    const user = createAccount(db, 'individual', 1, 100);
    updateBalance(db, user.account.id, 'supportive_balance', DAILY_SUPPORTIVE_POINTS);

    const mfg = createAccount(db, 'company', 1, 0);
    const desk = registerProduct(db, 'Desk', 'furniture', user.account.id, mfg.account.id);
    const laptop = registerProduct(db, 'Laptop', 'electronics', user.account.id, mfg.account.id);

    // Initial: desk 720min only
    const tags1 = submitSupportiveTags(db, user.account.id, 1, [
      { productId: desk.id, minutesUsed: 720 },
    ]);
    assert.equal(tags1.length, 1);
    assert.equal(tags1[0].pointsAllocated, DAILY_SUPPORTIVE_POINTS); // 100% to desk

    // Update: desk 720 + laptop 720 (50/50 split)
    const tags2 = submitSupportiveTags(db, user.account.id, 1, [
      { productId: desk.id, minutesUsed: 720 },
      { productId: laptop.id, minutesUsed: 720 },
    ]);
    assert.equal(tags2.length, 2);

    // Each should get 50%
    const deskTag = tags2.find(t => t.productId === desk.id)!;
    const laptopTag = tags2.find(t => t.productId === laptop.id)!;
    assert.equal(deskTag.pointsAllocated, DAILY_SUPPORTIVE_POINTS / 2n);
    assert.equal(laptopTag.pointsAllocated, DAILY_SUPPORTIVE_POINTS / 2n);

    // Should only have 2 active tags (old ones replaced)
    const allTags = getSupportiveTags(db, user.account.id, 1);
    assert.equal(allTags.length, 2);

    db.close();
  });

  // Test 8: End-of-day finalization
  it('finalizes all tags and burns remaining balances at end of day', () => {
    const db = freshDb();

    const user = createAccount(db, 'individual', 1, 100);
    updateBalance(db, user.account.id, 'supportive_balance', DAILY_SUPPORTIVE_POINTS);
    updateBalance(db, user.account.id, 'ambient_balance', DAILY_AMBIENT_POINTS);

    const mfg = createAccount(db, 'company', 1, 0);
    const desk = registerProduct(db, 'Desk', 'furniture', user.account.id, mfg.account.id);

    const buildingEntity = createAccount(db, 'company', 1, 0);
    const building = registerSpace(db, 'Office', 'building', undefined, buildingEntity.account.id, 0);

    // Only allocate SOME of supportive (desk for 480 min out of full day)
    submitSupportiveTags(db, user.account.id, 1, [{ productId: desk.id, minutesUsed: 480 }]);
    submitAmbientTags(db, user.account.id, 1, [{ spaceId: building.id, minutesOccupied: 1440 }]);

    // Finalize both
    const suppResult = finalizeSupportiveTags(db, user.account.id, 1);
    const ambResult = finalizeAmbientTags(db, user.account.id, 1);

    // Both balances should be 0
    const userAfter = getAccount(db, user.account.id)!;
    assert.equal(userAfter.supportiveBalance, 0n, 'Supportive should be fully spent/burned');
    assert.equal(userAfter.ambientBalance, 0n, 'Ambient should be fully spent/burned');

    // Manufacturer and building entity should have earned something
    const mfgAfter = getAccount(db, mfg.account.id)!;
    assert.ok(mfgAfter.earnedBalance > 0n);

    const bldgAfter = getAccount(db, buildingEntity.account.id)!;
    assert.ok(bldgAfter.earnedBalance > 0n);

    db.close();
  });
});
