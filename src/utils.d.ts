/// <reference types="node" />
/// <reference types="node" />
import { Psbt } from 'bitcoinjs-lib';
import { Bip32Derivation, PsbtInput } from 'bip174/src/lib/interfaces';
import { PayjoinClientOptionalParameters } from './client';
export declare enum ScriptPubKeyType {
    Unsupported = 0,
    Legacy = 1,
    Segwit = 2,
    SegwitP2SH = 3
}
export declare function getFee(feeRate: number, size: number): number;
export declare function getInputsScriptPubKeyType(psbt: Psbt): ScriptPubKeyType;
export declare function getInputScriptPubKeyType(psbt: Psbt, i: number): ScriptPubKeyType;
export declare function hasKeypathInformationSet(item: {
    bip32Derivation?: Bip32Derivation[];
}): boolean;
export declare function isFinalized(input: PsbtInput): boolean;
export declare function getInputIndex(psbt: Psbt, prevOutHash: Buffer, prevOutIndex: number): number;
export declare function getVirtualSize(scriptPubKeyType?: ScriptPubKeyType): number;
export declare function getEndpointUrl(url: string, payjoinParameters?: PayjoinClientOptionalParameters, setParamFunc?: (url: string, key: string, value: string) => string): string;
