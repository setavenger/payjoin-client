'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.PayjoinNostrHandler = exports.PayjoinEndpointError = void 0;
const bitcoinjs_lib_1 = require('bitcoinjs-lib');
const nostr_tools_1 = require('nostr-tools');
/**
 * Handle known errors and return a generic message for unkonw errors.
 *
 * This prevents people integrating this library introducing an accidental
 * phishing vulnerability in their app by displaying a server generated
 * messages in their UI.
 *
 * We still expose the error code so custom handling of specific or unknown
 * error codes can still be added in the app.
 */
class PayjoinEndpointError extends Error {
  static codeToMessage(code) {
    return (
      this.messageMap[code] ||
      'Something went wrong when requesting the payjoin endpoint.'
    );
  }
  constructor(code) {
    super(PayjoinEndpointError.codeToMessage(code));
    this.code = code;
  }
}
exports.PayjoinEndpointError = PayjoinEndpointError;
PayjoinEndpointError.messageMap = {
  unavailable: 'The payjoin endpoint is not available for now.',
  'not-enough-money':
    'The receiver added some inputs but could not bump the fee of the payjoin proposal.',
  'version-unsupported': 'This version of payjoin is not supported.',
  'original-psbt-rejected': 'The receiver rejected the original PSBT.',
};
class PayjoinNostrHandler {
  constructor(relayUrls, privateKey, pubkeySender, pubkeyReceiver) {
    this.relayUrls = relayUrls;
    this.privateKey = privateKey;
    this.pubkeySender = pubkeySender;
    this.pubkeyReceiver = pubkeyReceiver;
  }
  async sendOrgPayjoin(psbt) {
    if (!psbt) {
      throw new Error('Need to pass psbt');
    }
    const pool = new nostr_tools_1.SimplePool();
    const sub = pool.sub([...this.relayUrls], []);
    sub.on('event', (event) => {
      console.log(event);
    });
    // on the sender side
    const message = psbt.toBase64();
    const key = nostr_tools_1.nip44.utils.v2.getConversationKey(
      this.privateKey,
      this.pubkeyReceiver,
    );
    const ciphertext = nostr_tools_1.nip44.encrypt(key, message);
    const event = {
      kind: 4,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: this.pubkeySender,
      tags: [['p', this.pubkeyReceiver]],
      content: ciphertext,
    };
    const signedEvent = (0, nostr_tools_1.finishEvent)(event, this.privateKey);
    const pubs = pool.publish(this.relayUrls, signedEvent);
    await Promise.all(pubs);
    pool.close(this.relayUrls);
    return true;
  }
  async fetchPayjoinProposal() {
    const pool = new nostr_tools_1.SimplePool();
    const sub = pool.sub(
      [...this.relayUrls],
      [
        {
          authors: [this.pubkeyReceiver],
          '#p': [this.pubkeySender],
        },
      ],
    );
    return new Promise((resolve) => {
      setTimeout(() => {
        throw new Error('did not here back within timeout');
      }, 10000);
      sub.on('event', (event) => {
        console.debug(event);
        const key = nostr_tools_1.nip44.utils.v2.getConversationKey(
          this.privateKey,
          this.pubkeyReceiver,
        );
        const plainTextPSBT = nostr_tools_1.nip44.decrypt(key, event.content);
        console.debug(plainTextPSBT);
        resolve(bitcoinjs_lib_1.Psbt.fromBase64(plainTextPSBT));
      });
    });
  }
}
exports.PayjoinNostrHandler = PayjoinNostrHandler;
