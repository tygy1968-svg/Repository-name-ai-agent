import test from "node:test";
import assert from "node:assert/strict";
import { decideFactCandidate } from "../lib/fact-candidate-policy.js";

test("test brands never become approved facts", () => {
  const result = decideFactCandidate({content:"Пользователь развивает бренд AMADORA PRO",source:"telegram_extraction",evidence:"test"});
  assert.equal(result.mayPersistAsFact,false);
  assert.equal(result.status,"candidate");
});
test("model extraction of an apparent fact is not confirmation", () => {
  assert.equal(decideFactCandidate({content:"Пользователь живет в Граце",source:"telegram_extraction",evidence:"direct_confirmed"}).mayPersistAsFact,false);
});
test("quotations and hypothetical statements are candidates only", () => {
  for(const evidence of ["quotation","hypothetical","roleplay","unknown"]){
    assert.equal(decideFactCandidate({content:"Я владею брендом X",source:"telegram_extraction",evidence}).mayPersistAsFact,false);
  }
});
test("refutations require review and never promote their content", () => {
  const r=decideFactCandidate({content:"Бренд X не мой",refuted:true,source:"user_explicit_confirmation",evidence:"direct_confirmed",sourceMessageId:"m1",claimKey:"brand"});
  assert.equal(r.status,"refutation_review");
  assert.equal(r.mayPersistAsFact,false);
});
test("confirmed statements without traceable provenance cannot be promoted", () => {
  assert.equal(decideFactCandidate({content:"Факт",source:"user_explicit_confirmation",evidence:"direct_confirmed"}).mayPersistAsFact,false);
});
test("only explicitly confirmed traceable fact passes policy review gate", () => {
  const r=decideFactCandidate({content:"Пользователь предпочитает чай",source:"user_explicit_confirmation",evidence:"direct_confirmed",sourceMessageId:"telegram:123",claimKey:"preference:tea"});
  assert.equal(r.status,"approved_for_reviewed_write");
  assert.equal(r.mayPersistAsFact,true);
});
