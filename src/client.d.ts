/// <reference types="node" />
/// <reference types="node" />
import { IPayjoinRequester } from './request';
import { IPayjoinClientWallet } from './wallet';
import { IPayjoinNostrHandler } from './nostr';
export interface PayjoinClientOptionalParameters {
    disableOutputSubstitution?: boolean;
    payjoinVersion?: number;
    additionalFeeOutputIndex?: number;
    maxAdditionalFeeContribution?: number;
    minimumFeeRate?: number;
}
export declare class PayjoinClient {
    private wallet;
    private paymentScript;
    private payjoinRequester;
    private payjoinNostrHandler;
    private payjoinParameters?;
    constructor(opts: PayjoinClientOpts);
    run(): Promise<void>;
    runNostr(): Promise<void>;
}
type PayjoinClientOpts = PayjoinClientOptsUrl | PayjoinClientOptsRequester | PayjoinClientOptsNostrHandler;
interface PayjoinClientOptsUrl {
    wallet: IPayjoinClientWallet;
    payjoinUrl: string;
    paymentScript: Buffer;
    payjoinParameters?: PayjoinClientOptionalParameters;
    getEndpointUrl?: (url: string, payjoinParameters?: PayjoinClientOptionalParameters) => string;
}
interface PayjoinClientOptsRequester {
    wallet: IPayjoinClientWallet;
    payjoinRequester: IPayjoinRequester;
    paymentScript: Buffer;
    payjoinParameters?: PayjoinClientOptionalParameters;
}
interface PayjoinClientOptsNostrHandler {
    wallet: IPayjoinClientWallet;
    payjoinNostrHandler: IPayjoinNostrHandler;
    paymentScript: Buffer;
    payjoinParameters?: PayjoinClientOptionalParameters;
}
export {};
