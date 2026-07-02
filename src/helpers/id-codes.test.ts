import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateRoomCode, generatePersonalId, generatePersonalSecret } from "./id-codes.js";

// The relay hands these ids out to every participant. Room codes are typed by
// humans, so their shape matters; personal ids/secrets gate access to a room.
describe("id-codes", () => {

    describe("generateRoomCode", () => {
        it("is always exactly 4 uppercase alphanumeric characters", () => {
            for (let i = 0; i < 2000; i++) {
                const code = generateRoomCode();
                assert.equal(code.length, 4);
                assert.match(code, /^[0-9A-Z]{4}$/);
                assert.equal(code, code.toUpperCase());
            }
        });

        it("never contains ambiguous characters (vowels, 0, 1, or L)", () => {
            // The generator deliberately maps these out to avoid confusing or
            // word-forming codes. Every position must respect that.
            for (let i = 0; i < 5000; i++) {
                assert.doesNotMatch(generateRoomCode(), /[AEIOU01L]/);
            }
        });
    });

    describe("generatePersonalId", () => {
        it("is 12 lowercase-base36 characters", () => {
            for (let i = 0; i < 200; i++) {
                const id = generatePersonalId();
                assert.equal(id.length, 12);
                assert.match(id, /^[0-9a-z]{12}$/);
            }
        });

        it("produces distinct ids across many calls", () => {
            const seen = new Set<string>();
            for (let i = 0; i < 500; i++) seen.add(generatePersonalId());
            assert.equal(seen.size, 500);
        });
    });

    describe("generatePersonalSecret", () => {
        it("is 36 lowercase-base36 characters", () => {
            for (let i = 0; i < 200; i++) {
                const secret = generatePersonalSecret();
                assert.equal(secret.length, 36);
                assert.match(secret, /^[0-9a-z]{36}$/);
            }
        });

        it("produces distinct secrets across many calls", () => {
            const seen = new Set<string>();
            for (let i = 0; i < 500; i++) seen.add(generatePersonalSecret());
            assert.equal(seen.size, 500);
        });
    });
});
