import { Psbt } from 'bitcoinjs-lib';
import { SimplePool, nip44, finishEvent } from 'nostr-tools';

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
export class PayjoinEndpointError extends Error {
  static messageMap: { [key: string]: string } = {
    unavailable: 'The payjoin endpoint is not available for now.',
    'not-enough-money':
      'The receiver added some inputs but could not bump the fee of the payjoin proposal.',
    'version-unsupported': 'This version of payjoin is not supported.',
    'original-psbt-rejected': 'The receiver rejected the original PSBT.',
  };

  static codeToMessage(code: string): string {
    return (
      this.messageMap[code] ||
      'Something went wrong when requesting the payjoin endpoint.'
    );
  }

  code: string;

  constructor(code: string) {
    super(PayjoinEndpointError.codeToMessage(code));
    this.code = code;
  }
}

export interface IPayjoinNostrHandler {
  /**
   * @async
   * This requests the payjoin from the payjoin server
   *
   * @param {Psbt} psbt - A fully signed, finalized, and valid Psbt.
   * @return {Promise<Psbt>} The payjoin proposal Psbt.
   */
  sendOrgPayjoin(psbt: Psbt): Promise<boolean>;

  fetchPayjoinProposal(): Promise<Psbt>;
}

export class PayjoinNostrHandler implements IPayjoinNostrHandler {
  /**
   * @param relayUrls an array of relay urls e.g. ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.example.com']
   * @param privateKey hex representation of the senders private key
   * @param pubkeySender hex representation of the senders public key
   * @param pubkeyReceiver hex representation of the receivers public key
   */
  constructor(
    private relayUrls: string[],
    private privateKey: string,
    private pubkeySender: string,
    private pubkeyReceiver: string,
  ) {}

  async sendOrgPayjoin(psbt: Psbt): Promise<boolean> {
    if (!psbt) {
      throw new Error('Need to pass psbt');
    }

    const pool = new SimplePool();
    const sub = pool.sub([...this.relayUrls], []);
    sub.on('event', (event) => {
      console.log(event);
    });
    // on the sender side
    const message = psbt.toBase64();
    const key = nip44.utils.v2.getConversationKey(
      this.privateKey,
      this.pubkeyReceiver,
    );
    const ciphertext = nip44.encrypt(key, message);

    const event = {
      kind: 4,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: this.pubkeySender,
      tags: [['p', this.pubkeyReceiver]],
      content: ciphertext,
    };

    const signedEvent = finishEvent(event, this.privateKey);

    const pubs = pool.publish(this.relayUrls, signedEvent);
    await Promise.all(pubs);

    pool.close(this.relayUrls);

    return true;
  }

  async fetchPayjoinProposal(): Promise<Psbt> {
    const pool = new SimplePool();

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
      }, 10_000);
      sub.on('event', (event) => {
        console.debug(event);
        const key = nip44.utils.v2.getConversationKey(
          this.privateKey,
          this.pubkeyReceiver,
        );
        const plainTextPSBT = nip44.decrypt(key, event.content);
        console.debug(plainTextPSBT);
        resolve(Psbt.fromBase64(plainTextPSBT));
      });
    });
  }
}
