import { IPayjoinRequester, PayjoinRequester } from './request';
import { IPayjoinClientWallet } from './wallet';
import {
  getEndpointUrl,
  getFee,
  getInputIndex,
  getInputScriptPubKeyType,
  getInputsScriptPubKeyType,
  getVirtualSize,
  hasKeypathInformationSet,
  isFinalized,
} from './utils';
import { PsbtTxInput, PsbtTxOutput } from 'bitcoinjs-lib';
import { PsbtInput, PsbtOutput } from 'bip174/src/lib/interfaces';
import { IPayjoinNostrHandler } from './nostr';

const BROADCAST_ATTEMPT_TIME = 2 * 60 * 1000; // 2 minute

export interface PayjoinClientOptionalParameters {
  disableOutputSubstitution?: boolean;
  payjoinVersion?: number;
  additionalFeeOutputIndex?: number;
  maxAdditionalFeeContribution?: number;
  minimumFeeRate?: number;
}

export class PayjoinClient {
  private wallet: IPayjoinClientWallet;
  private paymentScript: Buffer;
  private payjoinRequester: IPayjoinRequester | undefined;
  private payjoinNostrHandler: IPayjoinNostrHandler | undefined;
  private payjoinParameters?: PayjoinClientOptionalParameters;

  constructor(opts: PayjoinClientOpts) {
    if (!opts.wallet) {
      throw new Error(
        'wallet (IPayjoinClientWallet) was not provided to PayjoinClient',
      );
    }
    if (!opts.paymentScript) {
      throw new Error(
        'paymentScript (output script of BIP21 destination) was not provided to PayjoinClient',
      );
    }
    this.wallet = opts.wallet;
    this.paymentScript = opts.paymentScript;
    this.payjoinParameters = opts.payjoinParameters;
    if (isRequesterOpts(opts)) {
      this.payjoinRequester = opts.payjoinRequester;
    } else if (isNostrOpts(opts)) {
      this.payjoinNostrHandler = opts.payjoinNostrHandler;
    } else if (!opts.payjoinUrl) {
      throw new Error(
        'payjoinUrl (value of the key pj of BIP21) OR payjoinRequester (IPayjoinRequester) was not provided to PayjoinClient',
      );
    } else {
      const endpointFunc = opts.getEndpointUrl || getEndpointUrl;
      this.payjoinRequester = new PayjoinRequester(
        endpointFunc(opts.payjoinUrl, opts.payjoinParameters),
      );
    }
  }

  async run(): Promise<void> {
    if (!this.payjoinRequester) {
      throw new Error("you can't use run with nostr handler");
    }
    const psbt = await this.wallet.getPsbt();
    const clonedPsbt = psbt.clone();
    const originalType = getInputsScriptPubKeyType(clonedPsbt);
    clonedPsbt.finalizeAllInputs();

    const originalTxHex = clonedPsbt.extractTransaction().toHex();
    const broadcastOriginalNow = (): Promise<string> =>
      this.wallet.broadcastTx(originalTxHex);

    try {
      // We make sure we don't send unnecessary information to the receiver
      for (let index = 0; index < clonedPsbt.inputCount; index++) {
        clonedPsbt.clearFinalizedInput(index);
      }
      clonedPsbt.data.outputs.forEach((output): void => {
        delete output.bip32Derivation;
      });
      delete clonedPsbt.data.globalMap.globalXpub;
      const originalInputs = clonedPsbt.txInputs.map((value, index): {
        originalTxIn: PsbtTxInput;
        signedPSBTInput: PsbtInput;
      } => {
        return {
          originalTxIn: value,
          signedPSBTInput: psbt.data.inputs[index],
        };
      });
      const originalOutputs = clonedPsbt.txOutputs.map((value, index): {
        originalTxOut: PsbtTxOutput;
        signedPSBTInput: PsbtOutput;
        index: number;
      } => {
        return {
          originalTxOut: value,
          signedPSBTInput: psbt.data.outputs[index],
          index,
        };
      });
      const feeOutput =
        this.payjoinParameters?.additionalFeeOutputIndex !== undefined
          ? originalOutputs[this.payjoinParameters?.additionalFeeOutputIndex]
          : null;
      const originalFeeRate = clonedPsbt.getFeeRate();
      const allowOutputSubstitution = !(
        this.payjoinParameters?.disableOutputSubstitution !== undefined &&
        this.payjoinParameters?.disableOutputSubstitution
      );
      const payjoinPsbt = await this.payjoinRequester.requestPayjoin(
        clonedPsbt,
      );
      if (!payjoinPsbt) throw new Error("We did not get the receiver's PSBT");

      if (
        payjoinPsbt.data.globalMap.globalXpub &&
        (payjoinPsbt.data.globalMap.globalXpub as any[]).length > 0
      ) {
        throw new Error(
          "GlobalXPubs should not be included in the receiver's PSBT",
        );
      }

      if (payjoinPsbt.version !== clonedPsbt.version) {
        throw new Error('The proposal PSBT changed the transaction version');
      }

      if (payjoinPsbt.locktime !== clonedPsbt.locktime) {
        throw new Error('The proposal PSBT changed the nLocktime');
      }

      const sequences: Set<number> = new Set<number>();

      // For each inputs in the proposal:
      for (let i = 0; i < payjoinPsbt.data.inputs.length; i++) {
        const proposedPSBTInput = payjoinPsbt.data.inputs[i];
        if (hasKeypathInformationSet(proposedPSBTInput))
          throw new Error('The receiver added keypaths to an input');
        if (
          proposedPSBTInput.partialSig &&
          proposedPSBTInput.partialSig.length > 0
        )
          throw new Error('The receiver added partial signatures to an input');

        const proposedTxIn = payjoinPsbt.txInputs[i];
        const ourInputIndex = getInputIndex(
          clonedPsbt,
          proposedTxIn.hash,
          proposedTxIn.index,
        );
        const isOurInput = ourInputIndex >= 0;
        // If it is one of our input
        if (isOurInput) {
          const input = originalInputs.splice(0, 1)[0];
          // Verify that sequence is unchanged.
          if (input.originalTxIn.sequence !== proposedTxIn.sequence)
            throw new Error(
              'The proposedTxIn modified the sequence of one of our inputs',
            );
          // Verify the PSBT input is not finalized
          if (isFinalized(proposedPSBTInput))
            throw new Error('The receiver finalized one of our inputs');
          // Verify that <code>non_witness_utxo</code> and <code>witness_utxo</code> are not specified.
          if (proposedPSBTInput.nonWitnessUtxo || proposedPSBTInput.witnessUtxo)
            throw new Error(
              'The receiver added non_witness_utxo or witness_utxo to one of our inputs',
            );
          if (proposedTxIn.sequence != null) {
            sequences.add(proposedTxIn.sequence);
          }

          // Fill up the info from the original PSBT input so we can sign and get fees.
          proposedPSBTInput.nonWitnessUtxo =
            input.signedPSBTInput.nonWitnessUtxo;
          proposedPSBTInput.witnessUtxo = input.signedPSBTInput.witnessUtxo;
          // We fill up information we had on the signed PSBT, so we can sign it.
          payjoinPsbt.data.inputs[i].bip32Derivation =
            input.signedPSBTInput.bip32Derivation || [];
          payjoinPsbt.data.inputs[i].nonWitnessUtxo =
            input.signedPSBTInput.nonWitnessUtxo;
          payjoinPsbt.data.inputs[i].witnessUtxo =
            input.signedPSBTInput.witnessUtxo;
          payjoinPsbt.data.inputs[i].redeemScript =
            input.signedPSBTInput.redeemScript;
          payjoinPsbt.data.inputs[i].sighashType =
            input.signedPSBTInput.sighashType;
        } else {
          // Verify the PSBT input is finalized
          if (!isFinalized(proposedPSBTInput))
            throw new Error(
              'The receiver did not finalized one of their input',
            );
          // Verify that non_witness_utxo or witness_utxo are filled in.
          if (
            !proposedPSBTInput.nonWitnessUtxo &&
            !proposedPSBTInput.witnessUtxo
          )
            throw new Error(
              'The receiver did not specify non_witness_utxo or witness_utxo for one of their inputs',
            );
          if (proposedTxIn.sequence != null) {
            sequences.add(proposedTxIn.sequence);
          }
          // Verify that the payjoin proposal did not introduced mixed input's type.
          if (originalType !== getInputScriptPubKeyType(payjoinPsbt, i))
            throw new Error('Mixed input type detected in the proposal');
        }
      }

      // Verify that all of sender's inputs from the original PSBT are in the proposal.
      if (originalInputs.length !== 0)
        throw new Error('Some of our inputs are not included in the proposal');

      // Verify that the payjoin proposal did not introduced mixed input's sequence.
      if (sequences.size !== 1)
        throw new Error('Mixed sequence detected in the proposal');

      const originalFee = clonedPsbt.getFee();
      let newFee: number;
      const signedPsbt = await this.wallet.signPsbt(payjoinPsbt);
      try {
        newFee = signedPsbt.getFee();
      } catch (e) {
        throw new Error(
          'The payjoin receiver did not included UTXO information to calculate fee correctly',
        );
      }
      const additionalFee = newFee - originalFee;
      if (additionalFee < 0)
        throw new Error('The receiver decreased absolute fee');

      // For each outputs in the proposal:
      for (let i = 0; i < payjoinPsbt.data.outputs.length; i++) {
        const proposedPSBTOutput = payjoinPsbt.data.outputs[i];
        const proposedTxOut = payjoinPsbt.txOutputs[i];

        // Verify that no keypaths is in the PSBT output

        if (hasKeypathInformationSet(proposedPSBTOutput))
          throw new Error('The receiver added keypaths to an output');

        if (originalOutputs.length === 0) continue;
        const originalOutput = originalOutputs[0];
        const isOriginalOutput = originalOutput.originalTxOut.script.equals(
          payjoinPsbt.txOutputs[i].script,
        );
        const substitutedOutput =
          !isOriginalOutput &&
          allowOutputSubstitution &&
          originalOutput.originalTxOut.script.equals(this.paymentScript);
        if (isOriginalOutput || substitutedOutput) {
          originalOutputs.splice(0, 1);
          if (
            feeOutput &&
            originalOutput.index ===
              this.payjoinParameters?.additionalFeeOutputIndex &&
            this.payjoinParameters?.maxAdditionalFeeContribution &&
            proposedTxOut.value !== feeOutput.originalTxOut.value
          ) {
            const actualContribution =
              feeOutput.originalTxOut.value - proposedTxOut.value;
            // The amount that was substracted from the output's value is less or equal to maxadditionalfeecontribution
            if (
              actualContribution >
              this.payjoinParameters?.maxAdditionalFeeContribution
            )
              throw new Error(
                `The actual contribution is more than maxadditionalfeecontribution`,
              );
            // Make sure the actual contribution is only paying fee
            if (actualContribution > additionalFee)
              throw new Error('The actual contribution is not only paying fee');
            // Make sure the actual contribution is only paying for fee incurred by additional inputs
            const additionalInputsCount =
              payjoinPsbt.txInputs.length - clonedPsbt.txInputs.length;
            if (
              actualContribution >
              getFee(originalFeeRate, getVirtualSize(originalType)) *
                additionalInputsCount
            )
              throw new Error(
                'The actual contribution is not only paying for additional inputs',
              );
          } else if (
            allowOutputSubstitution &&
            originalOutput.originalTxOut.script.equals(this.paymentScript)
          ) {
            // That's the payment output, the receiver may have changed it.
          } else {
            if (originalOutput.originalTxOut.value > proposedTxOut.value)
              throw new Error(
                'The receiver decreased the value of one of the outputs',
              );
          }
          // We fill up information we had on the signed PSBT, so we can sign it.
          payjoinPsbt.updateOutput(i, proposedPSBTOutput);
        }
      }
      // Verify that all of sender's outputs from the original PSBT are in the proposal.
      if (originalOutputs.length !== 0) {
        if (
          !allowOutputSubstitution ||
          originalOutputs.length !== 1 ||
          !originalOutputs
            .splice(0, 1)[0]
            .originalTxOut.script.equals(this.paymentScript)
        ) {
          throw new Error(
            'Some of our outputs are not included in the proposal',
          );
        }
      }

      // If minfeerate was specified, check that the fee rate of the payjoin transaction is not less than this value.
      if (this.payjoinParameters?.minimumFeeRate) {
        let newFeeRate: number;
        try {
          newFeeRate = payjoinPsbt.getFeeRate();
        } catch {
          throw new Error(
            'The payjoin receiver did not included UTXO information to calculate fee correctly',
          );
        }
        if (newFeeRate < this.payjoinParameters?.minimumFeeRate)
          throw new Error(
            'The payjoin receiver created a payjoin with a too low fee rate',
          );
      }

      // const signedPsbt = await this.wallet.signPsbt(payjoinPsbt);
      const tx = signedPsbt.extractTransaction();

      // Now broadcast. If this fails, there's a possibility the server is
      // trying to leak information by double spending an input, this is why
      // we schedule broadcast of original BEFORE we broadcast the payjoin.
      // And it is why schedule broadcast is expected to fail. (why you must
      // not throw an error.)
      const response = await this.wallet.broadcastTx(tx.toHex());
      if (response !== '') {
        throw new Error(
          'payjoin tx failed to broadcast.\nReason:\n' + response,
        );
      } else {
        // Schedule original tx broadcast after succeeding, just in case.
        await this.wallet.scheduleBroadcastTx(
          originalTxHex,
          BROADCAST_ATTEMPT_TIME,
        );
      }
    } catch (e) {
      // If anything goes wrong, broadcast original immediately.
      await broadcastOriginalNow();
      throw e;
    }
  }

  /**
   * This function has the same behavior as run but uses nostr for communication,
   * per default whenever it runs it makes an attempt to send the DM.
   * Use fetchOnly=true to run the function a second time to recheck for the proposal psbt
   * if you want to only fetch the Payjoin Proposal without resending the Original PSBT
   */
  async runNostr(fetchOnly: boolean = false): Promise<void> {
    if (!this.payjoinNostrHandler) {
      throw new Error("you can't use runNostr without nostr handler");
    }
    const psbt = await this.wallet.getPsbt();
    const clonedPsbt = psbt.clone();
    const originalType = getInputsScriptPubKeyType(clonedPsbt);
    clonedPsbt.finalizeAllInputs();

    const originalTxHex = clonedPsbt.extractTransaction().toHex();

    try {
      // We make sure we don't send unnecessary information to the receiver
      for (let index = 0; index < clonedPsbt.inputCount; index++) {
        clonedPsbt.clearFinalizedInput(index);
      }
      clonedPsbt.data.outputs.forEach((output): void => {
        delete output.bip32Derivation;
      });
      delete clonedPsbt.data.globalMap.globalXpub;
      const originalInputs = clonedPsbt.txInputs.map((value, index): {
        originalTxIn: PsbtTxInput;
        signedPSBTInput: PsbtInput;
      } => {
        return {
          originalTxIn: value,
          signedPSBTInput: psbt.data.inputs[index],
        };
      });
      const originalOutputs = clonedPsbt.txOutputs.map((value, index): {
        originalTxOut: PsbtTxOutput;
        signedPSBTInput: PsbtOutput;
        index: number;
      } => {
        return {
          originalTxOut: value,
          signedPSBTInput: psbt.data.outputs[index],
          index,
        };
      });
      const feeOutput =
        this.payjoinParameters?.additionalFeeOutputIndex !== undefined
          ? originalOutputs[this.payjoinParameters?.additionalFeeOutputIndex]
          : null;
      const originalFeeRate = clonedPsbt.getFeeRate();
      const allowOutputSubstitution = !(
        this.payjoinParameters?.disableOutputSubstitution !== undefined &&
        this.payjoinParameters?.disableOutputSubstitution
      );
      if (!fetchOnly) {
        await this.payjoinNostrHandler.sendOrgPayjoin(clonedPsbt);
      }
      const payjoinPsbt = await this.payjoinNostrHandler.fetchPayjoinProposal();

      if (!payjoinPsbt) throw new Error("We did not get the receiver's PSBT");

      if (
        payjoinPsbt.data.globalMap.globalXpub &&
        (payjoinPsbt.data.globalMap.globalXpub as any[]).length > 0
      ) {
        throw new Error(
          "GlobalXPubs should not be included in the receiver's PSBT",
        );
      }

      if (payjoinPsbt.version !== clonedPsbt.version) {
        throw new Error('The proposal PSBT changed the transaction version');
      }

      if (payjoinPsbt.locktime !== clonedPsbt.locktime) {
        throw new Error('The proposal PSBT changed the nLocktime');
      }

      const sequences: Set<number> = new Set<number>();

      // For each inputs in the proposal:
      for (let i = 0; i < payjoinPsbt.data.inputs.length; i++) {
        const proposedPSBTInput = payjoinPsbt.data.inputs[i];
        if (hasKeypathInformationSet(proposedPSBTInput))
          throw new Error('The receiver added keypaths to an input');
        if (
          proposedPSBTInput.partialSig &&
          proposedPSBTInput.partialSig.length > 0
        )
          throw new Error('The receiver added partial signatures to an input');

        const proposedTxIn = payjoinPsbt.txInputs[i];
        const ourInputIndex = getInputIndex(
          clonedPsbt,
          proposedTxIn.hash,
          proposedTxIn.index,
        );
        const isOurInput = ourInputIndex >= 0;
        // If it is one of our input
        if (isOurInput) {
          const input = originalInputs.splice(0, 1)[0];
          // Verify that sequence is unchanged.
          if (input.originalTxIn.sequence !== proposedTxIn.sequence)
            throw new Error(
              'The proposedTxIn modified the sequence of one of our inputs',
            );
          // Verify the PSBT input is not finalized
          if (isFinalized(proposedPSBTInput))
            throw new Error('The receiver finalized one of our inputs');
          // Verify that <code>non_witness_utxo</code> and <code>witness_utxo</code> are not specified.
          if (proposedPSBTInput.nonWitnessUtxo || proposedPSBTInput.witnessUtxo)
            throw new Error(
              'The receiver added non_witness_utxo or witness_utxo to one of our inputs',
            );
          if (proposedTxIn.sequence != null) {
            sequences.add(proposedTxIn.sequence);
          }

          // Fill up the info from the original PSBT input so we can sign and get fees.
          proposedPSBTInput.nonWitnessUtxo =
            input.signedPSBTInput.nonWitnessUtxo;
          proposedPSBTInput.witnessUtxo = input.signedPSBTInput.witnessUtxo;
          // We fill up information we had on the signed PSBT, so we can sign it.
          payjoinPsbt.data.inputs[i].bip32Derivation =
            input.signedPSBTInput.bip32Derivation || [];
          payjoinPsbt.data.inputs[i].nonWitnessUtxo =
            input.signedPSBTInput.nonWitnessUtxo;
          payjoinPsbt.data.inputs[i].witnessUtxo =
            input.signedPSBTInput.witnessUtxo;
          payjoinPsbt.data.inputs[i].redeemScript =
            input.signedPSBTInput.redeemScript;
          payjoinPsbt.data.inputs[i].sighashType =
            input.signedPSBTInput.sighashType;
        } else {
          // Verify the PSBT input is finalized
          if (!isFinalized(proposedPSBTInput))
            throw new Error(
              'The receiver did not finalized one of their input',
            );
          // Verify that non_witness_utxo or witness_utxo are filled in.
          if (
            !proposedPSBTInput.nonWitnessUtxo &&
            !proposedPSBTInput.witnessUtxo
          )
            throw new Error(
              'The receiver did not specify non_witness_utxo or witness_utxo for one of their inputs',
            );
          if (proposedTxIn.sequence != null) {
            sequences.add(proposedTxIn.sequence);
          }
          // Verify that the payjoin proposal did not introduced mixed input's type.
          if (originalType !== getInputScriptPubKeyType(payjoinPsbt, i))
            throw new Error('Mixed input type detected in the proposal');
        }
      }

      // Verify that all of sender's inputs from the original PSBT are in the proposal.
      if (originalInputs.length !== 0)
        throw new Error('Some of our inputs are not included in the proposal');

      // Verify that the payjoin proposal did not introduced mixed input's sequence.
      if (sequences.size !== 1)
        throw new Error('Mixed sequence detected in the proposal');

      const originalFee = clonedPsbt.getFee();
      let newFee: number;
      const signedPsbt = await this.wallet.signPsbt(payjoinPsbt);
      try {
        newFee = signedPsbt.getFee();
      } catch (e) {
        throw new Error(
          'The payjoin receiver did not included UTXO information to calculate fee correctly',
        );
      }
      const additionalFee = newFee - originalFee;
      if (additionalFee < 0)
        throw new Error('The receiver decreased absolute fee');

      // For each outputs in the proposal:
      for (let i = 0; i < payjoinPsbt.data.outputs.length; i++) {
        const proposedPSBTOutput = payjoinPsbt.data.outputs[i];
        const proposedTxOut = payjoinPsbt.txOutputs[i];

        // Verify that no keypaths is in the PSBT output

        if (hasKeypathInformationSet(proposedPSBTOutput))
          throw new Error('The receiver added keypaths to an output');

        if (originalOutputs.length === 0) continue;
        const originalOutput = originalOutputs[0];
        const isOriginalOutput = originalOutput.originalTxOut.script.equals(
          payjoinPsbt.txOutputs[i].script,
        );
        const substitutedOutput =
          !isOriginalOutput &&
          allowOutputSubstitution &&
          originalOutput.originalTxOut.script.equals(this.paymentScript);
        if (isOriginalOutput || substitutedOutput) {
          originalOutputs.splice(0, 1);
          if (
            feeOutput &&
            originalOutput.index ===
              this.payjoinParameters?.additionalFeeOutputIndex &&
            this.payjoinParameters?.maxAdditionalFeeContribution &&
            proposedTxOut.value !== feeOutput.originalTxOut.value
          ) {
            const actualContribution =
              feeOutput.originalTxOut.value - proposedTxOut.value;
            // The amount that was substracted from the output's value is less or equal to maxadditionalfeecontribution
            if (
              actualContribution >
              this.payjoinParameters?.maxAdditionalFeeContribution
            )
              throw new Error(
                `The actual contribution is more than maxadditionalfeecontribution`,
              );
            // Make sure the actual contribution is only paying fee
            if (actualContribution > additionalFee)
              throw new Error('The actual contribution is not only paying fee');
            // Make sure the actual contribution is only paying for fee incurred by additional inputs
            const additionalInputsCount =
              payjoinPsbt.txInputs.length - clonedPsbt.txInputs.length;
            if (
              actualContribution >
              getFee(originalFeeRate, getVirtualSize(originalType)) *
                additionalInputsCount
            )
              throw new Error(
                'The actual contribution is not only paying for additional inputs',
              );
          } else if (
            allowOutputSubstitution &&
            originalOutput.originalTxOut.script.equals(this.paymentScript)
          ) {
            // That's the payment output, the receiver may have changed it.
          } else {
            if (originalOutput.originalTxOut.value > proposedTxOut.value)
              throw new Error(
                'The receiver decreased the value of one of the outputs',
              );
          }
          // We fill up information we had on the signed PSBT, so we can sign it.
          payjoinPsbt.updateOutput(i, proposedPSBTOutput);
        }
      }
      // Verify that all of sender's outputs from the original PSBT are in the proposal.
      if (originalOutputs.length !== 0) {
        if (
          !allowOutputSubstitution ||
          originalOutputs.length !== 1 ||
          !originalOutputs
            .splice(0, 1)[0]
            .originalTxOut.script.equals(this.paymentScript)
        ) {
          throw new Error(
            'Some of our outputs are not included in the proposal',
          );
        }
      }

      // If minfeerate was specified, check that the fee rate of the payjoin transaction is not less than this value.
      if (this.payjoinParameters?.minimumFeeRate) {
        let newFeeRate: number;
        try {
          newFeeRate = payjoinPsbt.getFeeRate();
        } catch {
          throw new Error(
            'The payjoin receiver did not included UTXO information to calculate fee correctly',
          );
        }
        if (newFeeRate < this.payjoinParameters?.minimumFeeRate)
          throw new Error(
            'The payjoin receiver created a payjoin with a too low fee rate',
          );
      }

      // const signedPsbt = await this.wallet.signPsbt(payjoinPsbt);
      const tx = signedPsbt.extractTransaction();

      // Now broadcast. If this fails, there's a possibility the server is
      // trying to leak information by double spending an input, this is why
      // we schedule broadcast of original BEFORE we broadcast the payjoin.
      // And it is why schedule broadcast is expected to fail. (why you must
      // not throw an error.)
      const response = await this.wallet.broadcastTx(tx.toHex());
      if (response !== '') {
        throw new Error(
          'payjoin tx failed to broadcast.\nReason:\n' + response,
        );
      } else {
        // Schedule original tx broadcast after succeeding, just in case.
        await this.wallet.scheduleBroadcastTx(
          originalTxHex,
          BROADCAST_ATTEMPT_TIME,
        );
      }
    } catch (e) {
      // we don't want this anymore as we have an asynchronous flow now

      // If anything goes wrong, broadcast original immediately.
      // broadcastOriginalNow();
      throw e;
    }
  }

}

type PayjoinClientOpts =
  | PayjoinClientOptsUrl
  | PayjoinClientOptsRequester
  | PayjoinClientOptsNostrHandler;

interface PayjoinClientOptsUrl {
  wallet: IPayjoinClientWallet;
  payjoinUrl: string;
  paymentScript: Buffer;
  payjoinParameters?: PayjoinClientOptionalParameters;
  getEndpointUrl?: (
    url: string,
    payjoinParameters?: PayjoinClientOptionalParameters,
  ) => string;
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

function isRequesterOpts(
  opts: PayjoinClientOpts,
): opts is PayjoinClientOptsRequester {
  return (opts as PayjoinClientOptsRequester).payjoinRequester !== undefined;
}

function isNostrOpts(
  opts: PayjoinClientOpts,
): opts is PayjoinClientOptsNostrHandler {
  return (
    (opts as PayjoinClientOptsNostrHandler).payjoinNostrHandler !== undefined
  );
}
