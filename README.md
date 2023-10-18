# Payjoin Client

[![Build Status](https://travis-ci.com/bitcoinjs/payjoin-client.png?branch=master)](https://travis-ci.com/github/bitcoinjs/payjoin-client)

[![NPM](https://img.shields.io/npm/v/payjoin-client.svg)](https://www.npmjs.org/package/payjoin-client)

[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg?style=flat-square)](https://github.com/prettier/prettier)

A [BIP78 Payjoin client](https://github.com/bitcoin/bips/blob/master/bip-0078.mediawiki)
written in TypeScript with transpiled JavaScript committed to git.

## Example

TypeScript

Nostr Example
```typescript
const bitcoin = require("bitcoinjs-lib");
import { nip19, generatePrivateKey, getPublicKey } from "nostr-tools";


const bip21uri = "bitcoin:175tWpb8K1S7NmH4Zx6rewF9WQrcZv245W?pjnpub=npub1jfpffumqvyfuj7xgtmk3pe3npultvn2feh7n2qn5657xrsx6fzkq9hstew&pjnostrrelays=wss://relay1.example.com,wss://relay2.example.com,wss://relay3.example.com";

// parsing the uri results in
const address = "175tWpb8K1S7NmH4Zx6rewF9WQrcZv245W";
const npubReceiver = "npub1jfpffumqvyfuj7xgtmk3pe3npultvn2feh7n2qn5657xrsx6fzkq9hstew";
const relays = ["wss://relay1.example.com", "wss://relay2.example.com", "wss://relay3.example.com"];

// converting the address into a script
const script = bitcoin.address.toOutputScript(address);

// converting the npub into hex for later use
const { type, data } = nip19.decode(npub);
assert(type === "npub");

const pk2 = data; // `pk` is a hex string pub key of the receiver

// now generate the senders key pair
const sk1 = generatePrivateKey(); // generate a new private key every time you interact with a new transaction
const pk1 = getPublicKey(sk1); // `pk` is a hex string

// store sk1 in case we need it later (e.g. if there was no response on the first attempt)
// ...


const rootNode = bip32.fromBase58(VECTORS.privateRoot, network);
// test implementation needs an interface compliant real object
const wallet = new TestWallet(vector.wallet, rootNode);

const nostrHandler = new PayjoinNostrHandler(
  relays,
  sk1,
  pk1,
  pk2
);

const client = new PayjoinClient({
  wallet,
  payjoinNostrHandler: nostrHandler,
  paymentScript: getOutputScript(),
  payjoinParameters: vector.payjoinParameters
});

// this might go through in the first attempt if both peers are online the entire time
await client.runNostr();
// in case client.runNostr() fails we attempt to fetch the psbt again
// here we set the fetchOnly flag to true and now we won't resend the orignial PSBT and 
// only listen for the Payjoin Proposal PSBT
// we can now do this for example and try again after x seconds
setTimeout(async () => {
  await client.runNostr(false);
}, 10_000);

```

```typescript
// example implementation used for testing only
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
```

NodeJS

``` javascript

// ...
```

## LICENSE [MIT](LICENSE)
