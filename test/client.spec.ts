import '../polyfill.js';
import 'websocket-polyfill';

import {
  PayjoinClient,
  IPayjoinClientWallet,
  IPayjoinRequester,
} from '../ts_src/index';
import * as bitcoin from 'bitcoinjs-lib';
// @ts-ignore
import { default as VECTORS } from './fixtures/client.fixtures';
import { getEndpointUrl } from '../ts_src/utils';
import { BIP32Factory, BIP32Interface } from 'bip32';
import { PayjoinNostrHandler } from '../ts_src/nostr';
import { getPublicKey } from 'nostr-tools';
import { Psbt } from 'bitcoinjs-lib';

const ecc = require('tiny-secp256k1');
bitcoin.initEccLib(ecc);

// pass the regtest network to everything
const network = bitcoin.networks.regtest;
const bip32 = BIP32Factory(ecc);

describe('requestPayjoin', () => {
  it('should exist', () => {
    expect(PayjoinClient).toBeDefined();
    expect(typeof PayjoinClient).toBe('function'); // JS classes are functions
  });

  it('should throw on invalid opts', () => {
    expect(() => {
      new PayjoinClient(null as any);
    }).toThrow();
    expect(() => {
      new PayjoinClient({
        payjoinUrl: 'hello',
        wallet: new TestWallet(null as any, null as any),
        paymentScript: null as any,
      });
    }).toThrow();
    expect(() => {
      new PayjoinClient({
        payjoinUrl: null as any,
        wallet: new TestWallet(null as any, null as any),
        paymentScript: Buffer.from('chocolate', 'hex'),
      });
    }).toThrow();
  });
  expect(() => {
    new PayjoinClient({
      payjoinRequester: null as any,
      wallet: new TestWallet(null as any, null as any),
      paymentScript: Buffer.from('chocolate', 'hex'),
    });
  }).toThrow();

  VECTORS.valid.forEach((f) => {
    it('should request p2sh-p2wpkh payjoin', async () => {
      const paymentScript = Buffer.from(
        'a91457f78d3d696767f4d6d1c8ac5986babad244ed6f87',
        'hex',
      );
      await testPayjoin(f.p2shp2wpkh, () => {
        return paymentScript;
      });
    });
    it('should request p2wpkh payjoin', async () => {
      const paymentScript = Buffer.from(
        'a91457f78d3d696767f4d6d1c8ac5986babad244ed6f87',
        'hex',
      );
      await testPayjoin(f.p2wpkh, () => {
        return paymentScript;
      });
    });
  });
  VECTORS.invalid.forEach((f) => {
    it(f.description, async () => {
      const paymentScript = Buffer.from(
        'a91457f78d3d696767f4d6d1c8ac5986babad244ed6f87',
        'hex',
      );
      await expect(
        testPayjoin(f.vector, () => {
          return paymentScript;
        }),
      ).rejects.toThrowError(new RegExp(f.exception));
    });
  });
  // Nostr
  VECTORS.valid.forEach((f) => {
    it('should request p2sh-p2wpkh payjoin nostr', async () => {
      const paymentScript = Buffer.from(
        'a91457f78d3d696767f4d6d1c8ac5986babad244ed6f87',
        'hex',
      );
      await testPayjoinNostr(f.p2shp2wpkh, () => {
        return paymentScript;
      });
    });
    it('should request p2wpkh payjoin nostr', async () => {
      const paymentScript = Buffer.from(
        'a91457f78d3d696767f4d6d1c8ac5986babad244ed6f87',
        'hex',
      );
      await testPayjoinNostr(f.p2wpkh, () => {
        return paymentScript;
      });
    });
  });
  VECTORS.invalid.forEach((f) => {
    it(f.description + ' nostr', async () => {
      const paymentScript = Buffer.from(
        'a91457f78d3d696767f4d6d1c8ac5986babad244ed6f87',
        'hex',
      );
      await expect(
        testPayjoinNostr(f.vector, () => {
          return paymentScript;
        }),
      ).rejects.toThrowError(new RegExp(f.exception));
    });
  });
});

describe('getEndpointUrl', () => {
  it('should exist', () => {
    expect(typeof getEndpointUrl).toBe('function');
  });
  it('should add parameters specified', () => {
    expect(
      getEndpointUrl('https://gozo.com', {
        additionalFeeOutputIndex: 0,
        disableOutputSubstitution: false,
        minimumFeeRate: 1,
        payjoinVersion: 2,
        maxAdditionalFeeContribution: 2,
      }),
    ).toBe(
      'https://gozo.com/?disableoutputsubstitution=false&v=2&minfeerate=1&maxadditionalfeecontribution=2&additionalfeeoutputindex=0',
    );

    expect(getEndpointUrl('https://gozo.com', {})).toBe('https://gozo.com');
  });
});

async function testPayjoin(
  vector: any,
  getOutputScript: () => Buffer,
): Promise<void> {
  const rootNode = bip32.fromBase58(VECTORS.privateRoot, network);
  const wallet = new TestWallet(vector.wallet, rootNode);
  const payjoinRequester = new DummyRequester(vector.payjoin);
  const client = new PayjoinClient({
    wallet,
    payjoinRequester,
    paymentScript: getOutputScript(),
    payjoinParameters: vector.payjoinParameters,
  });

  await client.run();

  expect(wallet.tx).toBeDefined();
  expect(wallet.tx!.toHex()).toEqual(vector.finaltx);
}

async function testPayjoinNostr(
  vector: any,
  getOutputScript: () => Buffer,
): Promise<void> {
  const relays = ['wss://nos.lol']; // todo insert valid relay here, might want to use a custom one to avoid rate-limiting
  const sk1 =
    'e6d0db510ee6b9af33c0e927d3b4fb9cb5aab856959cf663231526289a21978a';
  const pk1 = getPublicKey(sk1); // `pk` is a hex string

  // const sk2 = 'bf0cd9cab5ed187a3f332a9f3cb0a536bf5549832606a8c1879a0d9e7f690ae8'
  const sk2 =
    'e6d0db510ee6b9af33c0e927d3b4fb9cb5aab856959cf663231526289a21978a';
  const pk2 = getPublicKey(sk2); // `pk` is a hex string

  const rootNode = bip32.fromBase58(VECTORS.privateRoot, network);
  const wallet = new TestWallet(vector.wallet, rootNode);
  const nostrHandler = new DummyPayjoinNostrHandler(
    relays,
    sk1,
    pk1,
    pk2,
    vector.payjoin,
  );
  const client = new PayjoinClient({
    wallet,
    payjoinNostrHandler: nostrHandler,
    paymentScript: getOutputScript(),
    payjoinParameters: vector.payjoinParameters,
  });

  await client.runNostr();

  expect(wallet.tx).toBeDefined();
  expect(wallet.tx!.toHex()).toEqual(vector.finaltx);
}

// Use this for testing
class TestWallet implements IPayjoinClientWallet {
  tx: bitcoin.Transaction | undefined;
  timeout: NodeJS.Timeout | undefined;

  constructor(private psbtString: string, private rootNode: BIP32Interface) {}

  async getPsbt(): Promise<bitcoin.Psbt> {
    return bitcoin.Psbt.fromBase64(this.psbtString, { network });
  }

  async signPsbt(psbt: bitcoin.Psbt): Promise<bitcoin.Psbt> {
    psbt.data.inputs.forEach((psbtInput, i) => {
      if (
        psbtInput.finalScriptSig === undefined &&
        psbtInput.finalScriptWitness === undefined
      ) {
        psbt.signInputHD(i, this.rootNode).finalizeInput(i);
      }
    });
    return psbt;
  }

  async broadcastTx(txHex: string): Promise<string> {
    this.tx = bitcoin.Transaction.fromHex(txHex);
    return '';
  }

  async scheduleBroadcastTx(txHex: string, ms: number): Promise<void> {
    return txHex + ms + 'x' ? undefined : undefined;
  }
}

class DummyRequester implements IPayjoinRequester {
  constructor(private psbt: string) {}

  async requestPayjoin(psbt: bitcoin.Psbt): Promise<bitcoin.Psbt> {
    const myString = psbt ? this.psbt : this.psbt;
    // @ts-ignore
    if (!myString) return;
    return bitcoin.Psbt.fromBase64(myString, { network });
  }
}

class DummyPayjoinNostrHandler extends PayjoinNostrHandler {
  /**
   * @param relayUrls an array of relay urls e.g. ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.example.com']
   * @param privateKey hex representation of the senders private key
   * @param pubkeySender hex representation of the senders public key
   * @param pubkeyReceiver hex representation of the receivers public key
   * @param psbt to be returned
   */
  constructor(
    relayUrls: string[],
    privateKey: string,
    pubkeySender: string,
    pubkeyReceiver: string,
    private psbt: string,
  ) {
    super(relayUrls, privateKey, pubkeySender, pubkeyReceiver);
  }

  async fetchPayjoinProposal(): Promise<Psbt> {
    if (!this.psbt) throw new Error("We did not get the receiver's PSBT");
    return bitcoin.Psbt.fromBase64(this.psbt, { network });
  }
}
