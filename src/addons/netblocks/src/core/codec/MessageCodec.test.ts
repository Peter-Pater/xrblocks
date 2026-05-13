import {describe, it, expect} from 'vitest';

import {MAX_MESSAGE_BYTES} from '../constants/NetConstants';

import {
  encodeMessage,
  decodeMessage,
  makeHello,
  HelloMessage,
  PoseMessage,
} from './MessageCodec';

describe('MessageCodec', () => {
  describe('encodeMessage / decodeMessage', () => {
    it('round-trips a hello message', () => {
      const msg: HelloMessage = {
        type: 'hello',
        protocol: 1,
        displayName: 'Alice',
        capabilities: {pose: true, voice: true, netobject: true},
        from: 'peer-A',
        ts: 12345,
      };
      const decoded = decodeMessage(encodeMessage(msg));
      expect(decoded).toEqual(msg);
    });

    it('round-trips a pose message', () => {
      const msg: PoseMessage = {
        type: 'pose',
        data: 'AAECAwQF', // arbitrary base64
        from: 'peer-B',
      };
      const decoded = decodeMessage(encodeMessage(msg));
      expect(decoded).toEqual(msg);
    });

    it('decodes from a string directly', () => {
      const json = '{"type":"ping","nonce":42}';
      const decoded = decodeMessage(json);
      expect(decoded.type).toBe('ping');
    });

    it('decodes from an ArrayBuffer', () => {
      const bytes = encodeMessage({type: 'ping', nonce: 7});
      const buf = bytes.slice().buffer; // detach to a real ArrayBuffer
      const decoded = decodeMessage(buf);
      expect(decoded.type).toBe('ping');
    });

    it('throws when the payload exceeds MAX_MESSAGE_BYTES', () => {
      // Build a Uint8Array just over the cap; content doesn't matter — the
      // size check fires before JSON parsing.
      const bytes = new Uint8Array(MAX_MESSAGE_BYTES + 1);
      expect(() => decodeMessage(bytes)).toThrow(/MAX_MESSAGE_BYTES/);
    });

    it('throws on oversized strings too', () => {
      const big = 'a'.repeat(MAX_MESSAGE_BYTES + 1);
      expect(() => decodeMessage(big)).toThrow(/MAX_MESSAGE_BYTES/);
    });

    it('throws on oversized ArrayBuffer too', () => {
      const buf = new ArrayBuffer(MAX_MESSAGE_BYTES + 1);
      expect(() => decodeMessage(buf)).toThrow(/MAX_MESSAGE_BYTES/);
    });

    it('accepts payloads at exactly the limit', () => {
      // A valid JSON 'ping' padded with whitespace up to the cap.
      const base = '{"type":"ping","nonce":1}';
      const padded = base + ' '.repeat(MAX_MESSAGE_BYTES - base.length);
      expect(padded.length).toBe(MAX_MESSAGE_BYTES);
      const decoded = decodeMessage(padded);
      expect(decoded.type).toBe('ping');
    });
  });

  describe('makeHello', () => {
    it('builds a HelloMessage with the current protocol version', () => {
      const caps = {pose: true, voice: false, netobject: true};
      const hello = makeHello('Bob', caps);
      expect(hello.type).toBe('hello');
      expect(hello.protocol).toBe(1);
      expect(hello.displayName).toBe('Bob');
      expect(hello.capabilities).toEqual(caps);
    });

    it('allows undefined displayName', () => {
      const hello = makeHello(undefined, {
        pose: false,
        voice: false,
        netobject: false,
      });
      expect(hello.displayName).toBeUndefined();
    });
  });
});
