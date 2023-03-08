import { getAddress } from "@ethersproject/address";
import { Provider, TransactionRequest } from "@ethersproject/abstract-provider";
import { ExternallyOwnedAccount, Signer, TypedDataDomain, TypedDataField, TypedDataSigner } from "@ethersproject/abstract-signer";
import { arrayify, Bytes, BytesLike, concat, hexDataSlice, isHexString, joinSignature, SignatureLike } from "@ethersproject/bytes";
import { hashMessage, _TypedDataEncoder } from "@ethersproject/hash";
import { defaultPath, HDNode, entropyToMnemonic, Mnemonic } from "@ethersproject/hdnode";
import { keccak256 } from "@ethersproject/keccak256";
import { defineReadOnly, resolveProperties } from "@ethersproject/properties";
import { randomBytes } from "@ethersproject/random";
import { decryptJsonWallet, decryptJsonWalletSync, encryptKeystore, ProgressCallback } from "@ethersproject/json-wallets";
import { computeAddress, serialize, UnsignedTransaction } from "@ethersproject/transactions";
import { Wordlist } from "@ethersproject/wordlists";
import { Logger } from "@ethersproject/logger";
import { version } from "ethers"
import * as LitJsSdk from '@lit-protocol/lit-node-client';

import { ethers, Wallet } from 'ethers'

const logger = new Logger(version);

export interface PKPWalletProp{
  pkpPubKey: string;
  controllerAuthSig: any;
  provider: string;
  litNetwork?: any;
  debug?: boolean;
  litActionCode?: string;
}

export interface PKPSigner{
  initPKP(prop: PKPWalletProp): any;
  runLitAction(toSign: Uint8Array | BytesLike): Promise<any>
}

export class PKPWallet extends Signer implements ExternallyOwnedAccount, TypedDataSigner{

  // @ts-ignore
  readonly address: string;
  // @ts-ignore
  readonly provider: Provider;
  pkpWalletProp: PKPWalletProp;
  litNodeClient: any;
  rpcProvider: ethers.providers.JsonRpcProvider;
  litActionCode: string;

  // Wrapping the _signingKey and _mnemonic in a getter function prevents
  // leaking the private key in console.log; still, be careful! :)
  // readonly _signingKey: () => SigningKey;
  // readonly _mnemonic: () => Mnemonic;

  async runLitAction(toSign: Uint8Array | BytesLike, sigName: string): Promise<any> {

      if ( ! this.pkpWalletProp.controllerAuthSig || ! this.pkpWalletProp.pkpPubKey) {
          throw new Error("controllerAuthSig and pkpPubKey are required");
      }

      const res = await this.litNodeClient.executeJs({
          code: this.litActionCode,
          authSig: this.pkpWalletProp.controllerAuthSig,
          jsParams: {
              toSign,
              publicKey: this.pkpWalletProp.pkpPubKey,
              sigName,
          },  
      });

      console.log("res:", res);
      console.log("res.signatures[sigName]:", res.signatures[sigName]);
      
      return res.signatures[sigName]
  }

  constructor(prop: PKPWalletProp) {
      super();

      this.pkpWalletProp = prop;

      this.litNodeClient = new LitJsSdk.LitNodeClient({ 
          litNetwork: prop.litNetwork ?? 'serrano',
          debug: prop.debug ?? false,
      });

      this.rpcProvider = new ethers.providers.JsonRpcProvider(this.pkpWalletProp.provider);
      
      defineReadOnly(this, "address", computeAddress(this.pkpWalletProp.pkpPubKey));

      /* istanbul ignore if */
      // if (prop.provider && !Provider.isProvider(prop.provider)) {
      //     logger.throwArgumentError("invalid provider", "provider", prop.provider);
      // }

      this.litActionCode = prop.litActionCode ?? `
      (async () => {
          const sigShare = await LitActions.signEcdsa({ toSign, publicKey, sigName });
      })();`;

  }

  get mnemonic() { 
      throw new Error("There's no mnemonic for a PKPWallet");
  };

  get privateKey(): string {
      throw new Error("There's no private key for a PKPWallet. (Can you imagine!?)");
  }
   
  get publicKey(): string { 
      return this.pkpWalletProp.pkpPubKey;
   }

  getAddress(): Promise<string> {
      const addr = computeAddress(this.publicKey);
      return Promise.resolve(addr);
  }

  connect(): PKPWallet {
      // throw new Error("PKPWallet cannot be connected to a provider");
      return new PKPWallet(this.pkpWalletProp);
  }

  async init(){
      await this.litNodeClient.connect();
  }

  async signTransaction(transaction: TransactionRequest): Promise<string> {

      const addr = await this.getAddress();

      if ( ! transaction['nonce'] ) {
          transaction.nonce = await this.rpcProvider.getTransactionCount(addr);
      }

      if ( ! transaction['chainId'] ) {
          transaction.chainId = (await this.rpcProvider.getNetwork()).chainId;
      }

      if ( ! transaction['gasPrice'] ) {
          transaction.gasPrice = await this.rpcProvider.getGasPrice();
      }

      if ( ! transaction['gasLimit'] ) {
          transaction.gasLimit = await this.rpcProvider.estimateGas(transaction);
      }

      return resolveProperties(transaction).then(async (tx) => {

          console.log("tx.from:", tx.from);
          console.log("this.address:", this.address);

          if (tx.from != null) {
              if (getAddress(tx.from) !== this.address) {
                  logger.throwArgumentError("transaction from address mismatch", "transaction.from", transaction.from);
              }
              delete tx.from;
          }

          const serializedTx = serialize(<UnsignedTransaction>tx);
          const unsignedTxn = keccak256(serializedTx);

          // -- lit action --
          const toSign = arrayify(unsignedTxn);
          console.log("We are here!");
          const signature = (await this.runLitAction(toSign, 'pkp-eth-sign-tx')).signature;

          console.log("How about this?");
          // -- original code --
          // const signature = this._signingKey().signDigest(unsignedTxn);

          console.log("signature", signature);

          return serialize(<UnsignedTransaction>tx, signature);
      });
  }

  async signMessage(message: Bytes | string): Promise<string> {

      // return joinSignature(this._signingKey().signDigest(hashMessage(message)));

      const toSign = arrayify(hashMessage(message));

      const signature = await this.runLitAction(toSign, 'pkp-eth-sign-message');

      return joinSignature({
          r: '0x' + signature.r,
          s: '0x' + signature.s,
          v: signature.recid,
      });
;
  }

  async _signTypedData(domain: TypedDataDomain, types: Record<string, Array<TypedDataField>>, value: Record<string, any>): Promise<string> {
      // Populate any ENS names
      // @ts-ignore
      const populated = await _TypedDataEncoder.resolveNames(domain, types, value, (name: string) => {
          if (this.provider == null) {
              logger.throwError("cannot resolve ENS names without a provider", Logger.errors.UNSUPPORTED_OPERATION, {
                  operation: "resolveName",
                  value: name
              });
          }
          return this.provider.resolveName(name);
      });
      
      // -- lit action --
      const toSign = _TypedDataEncoder.hash(populated.domain, types, populated.value);
      const signature = await this.runLitAction(arrayify(toSign), 'pkp-eth-sign-typed-data');
      return joinSignature({
          r: '0x' + signature.r,
          s: '0x' + signature.s,
          v: signature.recid,
      });
  }

  encrypt(password: Bytes | string, options?: any, progressCallback?: ProgressCallback): Promise<string> {
      if (typeof(options) === "function" && !progressCallback) {
          progressCallback = options;
          options = {};
      }

      if (progressCallback && typeof(progressCallback) !== "function") {
          throw new Error("invalid callback");
      }

      if (!options) { options = {}; }

      return encryptKeystore(this, password, options, progressCallback);
  }

  override async sendTransaction(transaction: TransactionRequest | any): Promise<any> {
      return await this.rpcProvider.sendTransaction(transaction);
  };


  /**
   *  Static methods to create Wallet instances.
   */
  static createRandom(options?: any): Wallet {
      let entropy: Uint8Array = randomBytes(16);

      if (!options) { options = { }; }

      if (options.extraEntropy) {
          entropy = arrayify(hexDataSlice(keccak256(concat([ entropy, options.extraEntropy ])), 0, 16));
      }

      const mnemonic = entropyToMnemonic(entropy, options.locale);
      return Wallet.fromMnemonic(mnemonic, options.path, options.locale);
  }

  static fromEncryptedJson(json: string, password: Bytes | string, progressCallback?: ProgressCallback): Promise<Wallet> {
      return decryptJsonWallet(json, password, progressCallback).then((account) => {
          return new Wallet(account);
      });
  }

  static fromEncryptedJsonSync(json: string, password: Bytes | string): Wallet {
      return new Wallet(decryptJsonWalletSync(json, password));
  }

  static fromMnemonic(mnemonic: string, path?: string, wordlist?: Wordlist): Wallet {
      if (!path) { path = defaultPath; }
      // @ts-ignore
      return new Wallet(HDNode.fromMnemonic(mnemonic, null, wordlist).derivePath(path));
  }
}
