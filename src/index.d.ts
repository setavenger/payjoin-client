import { Psbt } from 'bitcoinjs-lib';
declare type Nullable<T> = T | null;
declare enum ScriptPubKeyType {
    Legacy = 0,
    Segwit = 1,
    SegwitP2SH = 2
}
export declare const supportedWalletFormats: ScriptPubKeyType[];
export declare function requestPayjoinWithCustomRemoteCall(psbt: Psbt, remoteCall: (psbt: Psbt) => Promise<Nullable<Psbt>>): Promise<Psbt>;
export declare function requestPayjoin(psbt: Psbt, payjoinEndpoint: string): Promise<Psbt>;
export {};
