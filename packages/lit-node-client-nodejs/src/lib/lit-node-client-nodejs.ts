import { computeAddress } from '@ethersproject/transactions';
import { BigNumber, ethers } from 'ethers';
import { sha256 } from 'ethers/lib/utils';
import { SiweMessage } from 'siwe';

import {
  ILitResource,
  ISessionCapabilityObject,
  LitAccessControlConditionResource,
  LitResourceAbilityRequest,
  decode,
  RecapSessionCapabilityObject,
  generateAuthSig,
  createSiweMessageWithCapacityDelegation,
  createSiweMessageWithRecaps,
  createSiweMessage,
} from '@lit-protocol/auth-helpers';
import {
  AuthMethodType,
  EITHER_TYPE,
  LIT_ACTION_IPFS_HASH,
  LIT_CURVE,
  LIT_ENDPOINT,
  LIT_ERROR,
  LIT_SESSION_KEY_URI,
  LOCAL_STORAGE_KEYS,
  LitNetwork,
} from '@lit-protocol/constants';
import { LitCore, composeLitUrl } from '@lit-protocol/core';
import {
  combineSignatureShares,
  encrypt,
  generateSessionKeyPair,
  verifyAndDecryptWithSignatureShares,
} from '@lit-protocol/crypto';
import { safeParams } from '@lit-protocol/encryption';
import {
  defaultMintClaimCallback,
  executeWithRetry,
  findMostCommonResponse,
  hexPrefixed,
  log,
  logError,
  logErrorWithRequestId,
  logWithRequestId,
  mostCommonString,
  normalizeAndStringify,
  removeHexPrefix,
  throwError,
} from '@lit-protocol/misc';
import {
  getStorageItem,
  removeStorageItem,
  setStorageItem,
} from '@lit-protocol/misc-browser';
import { nacl } from '@lit-protocol/nacl';
import {
  uint8arrayFromString,
  uint8arrayToString,
} from '@lit-protocol/uint8arrays';

import type {
  AuthCallback,
  AuthCallbackParams,
  AuthSig,
  ClaimKeyResponse,
  ClaimProcessor,
  ClaimRequest,
  CustomNetwork,
  DecryptRequest,
  DecryptResponse,
  EncryptRequest,
  EncryptResponse,
  ExecuteJsResponse,
  FormattedMultipleAccs,
  GetSessionSigsProps,
  GetSignedTokenRequest,
  GetWalletSigProps,
  JsonExecutionRequest,
  JsonPkpSignRequest,
  LitClientSessionManager,
  LitNodeClientConfig,
  NodeBlsSigningShare,
  NodeCommandResponse,
  NodeLog,
  NodeShare,
  PKPSignShare,
  RejectedNodePromises,
  SessionKeyPair,
  SessionSigningTemplate,
  SessionSigsMap,
  SignSessionKeyProp,
  SignSessionKeyResponse,
  Signature,
  SigningAccessControlConditionRequest,
  SuccessNodePromises,
  ILitNodeClient,
  GetPkpSessionSigs,
  CapacityCreditsReq,
  CapacityCreditsRes,
  JsonSignSessionKeyRequestV1,
  BlsResponseData,
  JsonExecutionSdkParamsTargetNode,
  JsonExecutionRequestTargetNode,
  JsonExecutionSdkParams,
  ExecuteJsNoSigningResponse,
  JsonPkpSignSdkParams,
  SigResponse,
  EncryptSdkParams,
  GetLitActionSessionSigs,
  EncryptionSignRequest,
  JsonPKPClaimKeyRequest,
} from '@lit-protocol/types';

import * as blsSdk from '@lit-protocol/bls-sdk';
import { normalizeJsParams } from './helpers/normalize-params';
import { encodeCode } from './helpers/encode-code';
import { getSignatures } from './helpers/get-signatures';
import { removeDoubleQuotes } from './helpers/remove-double-quotes';
import { parseAsJsonOrString } from './helpers/parse-as-json-or-string';
import { getClaimsList } from './helpers/get-claims-list';
import { getClaims } from './helpers/get-claims';
import { normalizeArray } from './helpers/normalize-array';
import { parsePkpSignResponse } from './helpers/parse-pkp-sign-response';
import { getBlsSignatures } from './helpers/get-bls-signatures';
import { processLitActionResponseStrategy } from './helpers/process-lit-action-response-strategy';

export class LitNodeClientNodeJs
  extends LitCore
  implements LitClientSessionManager, ILitNodeClient
{
  defaultAuthCallback?: (authSigParams: AuthCallbackParams) => Promise<AuthSig>;

  // ========== Constructor ==========
  constructor(args: LitNodeClientConfig | CustomNetwork) {
    if (!args) {
      throwError({
        message: 'must provide LitNodeClient parameters',
        errorKind: LIT_ERROR.PARAMS_MISSING_ERROR.kind,
        errorCode: LIT_ERROR.PARAMS_MISSING_ERROR.name,
      });
    }

    super(args);

    if (args !== undefined && args !== null && 'defaultAuthCallback' in args) {
      this.defaultAuthCallback = args.defaultAuthCallback;
    }
  }

  // ========== Private Methods ==========
  /**
   * Handles the authentication callback and updates the storage item with the authentication signature.
   * @param authCallbackParams - The parameters required for the authentication callback.
   * @param authCallback - The optional authentication callback function.
   * @returns A promise that resolves to the authentication signature.
   * @throws An error if no default authentication callback is provided.
   */
  #authCallbackAndUpdateStorageItem = async ({
    authCallbackParams,
    authCallback,
  }: {
    authCallbackParams: AuthCallbackParams;
    authCallback?: AuthCallback;
  }): Promise<AuthSig> => {
    let authSig: AuthSig;

    if (authCallback) {
      authSig = await authCallback(authCallbackParams);
    } else {
      if (!this.defaultAuthCallback) {
        return throwError({
          message: 'No default auth callback provided',
          errorKind: LIT_ERROR.PARAMS_MISSING_ERROR.kind,
          errorCode: LIT_ERROR.PARAMS_MISSING_ERROR.name,
        });
      }
      authSig = await this.defaultAuthCallback(authCallbackParams);
    }

    // (TRY) to set walletSig to local storage
    const storeNewWalletSigOrError = setStorageItem(
      LOCAL_STORAGE_KEYS.WALLET_SIGNATURE,
      JSON.stringify(authSig)
    );
    if (storeNewWalletSigOrError.type === EITHER_TYPE.SUCCESS) {
      return authSig;
    }

    // Setting local storage failed, try to remove the item key.
    console.warn(
      `Unable to store walletSig in local storage. Not a problem. Continuing to remove item key...`
    );
    const removeWalletSigOrError = removeStorageItem(
      LOCAL_STORAGE_KEYS.WALLET_SIGNATURE
    );
    if (removeWalletSigOrError.type === EITHER_TYPE.ERROR) {
      console.warn(
        `Unable to remove walletSig in local storage. Not a problem. Continuing...`
      );
    }

    return authSig;
  };
  /**
   *
   * Check if a session key needs to be resigned. These are the scenarios where a session key needs to be resigned:
   * 1. The authSig.sig does not verify successfully against the authSig.signedMessage
   * 2. The authSig.signedMessage.uri does not match the sessionKeyUri
   * 3. The authSig.signedMessage does not contain at least one session capability object
   *
   */
  #checkNeedToResignSessionKey = async ({
    authSig,
    sessionKeyUri,
    resourceAbilityRequests,
  }: {
    authSig: AuthSig;
    sessionKeyUri: any;
    resourceAbilityRequests: LitResourceAbilityRequest[];
  }): Promise<boolean> => {
    const authSigSiweMessage = new SiweMessage(authSig.signedMessage);

    try {
      await authSigSiweMessage.validate(authSig.sig);
    } catch (e) {
      console.debug('Need retry because verify failed', e);
      return true;
    }

    // make sure the sig is for the correct session key
    if (authSigSiweMessage.uri !== sessionKeyUri) {
      console.debug('Need retry because uri does not match');
      return true;
    }

    // make sure the authSig contains at least one resource.
    if (
      !authSigSiweMessage.resources ||
      authSigSiweMessage.resources.length === 0
    ) {
      console.debug('Need retry because empty resources');
      return true;
    }

    // make sure the authSig contains session capabilities that can be parsed.
    // TODO: we currently only support the first resource being a session capability object.
    const authSigSessionCapabilityObject = decode(
      authSigSiweMessage.resources[0]
    );

    // make sure the authSig session capability object describes capabilities that are equal or greater than
    // the abilities requested against the resources in the resource ability requests.
    for (const resourceAbilityRequest of resourceAbilityRequests) {
      if (
        !authSigSessionCapabilityObject.verifyCapabilitiesForResource(
          resourceAbilityRequest.resource,
          resourceAbilityRequest.ability
        )
      ) {
        console.debug('Need retry because capabilities do not match', {
          authSigSessionCapabilityObject,
          resourceAbilityRequest,
        });
        return true;
      }
    }

    return false;
  };
  /**
   * Decrypts the ciphertext using the provided signature shares.
   *
   * @param networkPubKey - The network public key.
   * @param identityParam - The identity parameter.
   * @param ciphertext - The ciphertext to decrypt.
   * @param signatureShares - An array of signature shares.
   * @returns The decrypted data as a Uint8Array.
   */
  #decryptWithSignatureShares = (
    networkPubKey: string,
    identityParam: Uint8Array,
    ciphertext: string,
    signatureShares: NodeBlsSigningShare[]
  ): Uint8Array => {
    const sigShares = signatureShares.map((s: any) => s.signatureShare);

    return verifyAndDecryptWithSignatureShares(
      networkPubKey,
      identityParam,
      ciphertext,
      sigShares
    );
  };
  /**
   * Checks if the given response is a success node promise.
   * @private
   * @param res - The response object to check.
   * @returns A boolean indicating whether the response is a success node promise.
   * @template T - The type of the success node promise.
   */
  #isSuccessNodePromises = <T>(res: any): res is SuccessNodePromises<T> => {
    return res.success === true;
  };
  /**
   * Generates an identity parameter for encryption based on the provided conditions and private data.
   * @param hashOfConditionsStr - The hash of the conditions string.
   * @param hashOfPrivateDataStr - The hash of the private data string.
   * @returns The generated identity parameter for encryption.
   */
  #getIdentityParamForEncryption = (
    hashOfConditionsStr: string,
    hashOfPrivateDataStr: string
  ): string => {
    return new LitAccessControlConditionResource(
      `${hashOfConditionsStr}/${hashOfPrivateDataStr}`
    ).getResourceKey();
  };
  /**
   *
   * we need to send jwt params iat (issued at) and exp (expiration) because the nodes may have different wall clock times, the nodes will verify that these params are withing a grace period
   *
   */
  #getJWTParams = () => {
    const now = Date.now();
    const iat = Math.floor(now / 1000);
    const exp = iat + 12 * 60 * 60; // 12 hours in seconds

    return { iat, exp };
  };
  /**
   *
   * Get the signature from local storage, if not, generates one
   *
   */
  #getWalletSig = async ({
    authNeededCallback,
    chain,
    sessionCapabilityObject,
    switchChain,
    expiration,
    sessionKeyUri,
    nonce,
    resourceAbilityRequests,
    litActionCode,
    litActionIpfsId,
    jsParams,
    sessionKey,
  }: GetWalletSigProps): Promise<AuthSig> => {
    let walletSig: AuthSig;

    const storageKey = LOCAL_STORAGE_KEYS.WALLET_SIGNATURE;
    const storedWalletSigOrError = getStorageItem(storageKey);

    // browser: 2 > 2.1 > 3
    // nodejs: 1. > 1.1

    // -- (TRY) to get it in the local storage
    // -- IF NOT: Generates one
    log(`getWalletSig - flow starts
        storageKey: ${storageKey}
        storedWalletSigOrError: ${JSON.stringify(storedWalletSigOrError)}
    `);

    if (
      storedWalletSigOrError.type === EITHER_TYPE.ERROR ||
      !storedWalletSigOrError.result ||
      storedWalletSigOrError.result == ''
    ) {
      log('getWalletSig - flow 1');
      console.warn(
        `Storage key "${storageKey}" is missing. Not a problem. Continue...`
      );
      if (authNeededCallback) {
        log('getWalletSig - flow 1.1');

        const body = {
          chain,
          statement: sessionCapabilityObject?.statement,
          resources: sessionCapabilityObject
            ? [sessionCapabilityObject.encodeAsSiweResource()]
            : undefined,
          ...(switchChain && { switchChain }),
          expiration,
          uri: sessionKeyUri,
          sessionKey: sessionKey,
          nonce,

          // for recap
          ...(resourceAbilityRequests && { resourceAbilityRequests }),

          // for lit action custom auth
          ...(litActionCode && { litActionCode }),
          ...(litActionIpfsId && { litActionIpfsId }),
          ...(jsParams && { jsParams }),
        };

        log('callback body:', body);

        walletSig = await authNeededCallback(body);
      } else {
        log('getWalletSig - flow 1.2');
        if (!this.defaultAuthCallback) {
          log('getWalletSig - flow 1.2.1');
          return throwError({
            message: 'No default auth callback provided',
            errorKind: LIT_ERROR.PARAMS_MISSING_ERROR.kind,
            errorCode: LIT_ERROR.PARAMS_MISSING_ERROR.name,
          });
        }

        log('getWalletSig - flow 1.2.2');
        walletSig = await this.defaultAuthCallback({
          chain,
          statement: sessionCapabilityObject.statement,
          resources: sessionCapabilityObject
            ? [sessionCapabilityObject.encodeAsSiweResource()]
            : undefined,
          switchChain,
          expiration,
          uri: sessionKeyUri,
          nonce,
        });
      }

      log('getWalletSig - flow 1.3');

      // (TRY) to set walletSig to local storage
      const storeNewWalletSigOrError = setStorageItem(
        storageKey,
        JSON.stringify(walletSig)
      );
      if (storeNewWalletSigOrError.type === 'ERROR') {
        log('getWalletSig - flow 1.4');
        console.warn(
          `Unable to store walletSig in local storage. Not a problem. Continue...`
        );
      }
    } else {
      log('getWalletSig - flow 2');
      try {
        walletSig = JSON.parse(storedWalletSigOrError.result as string);
        log('getWalletSig - flow 2.1');
      } catch (e) {
        console.warn('Error parsing walletSig', e);
        log('getWalletSig - flow 2.2');
      }
    }

    log('getWalletSig - flow 3');
    return walletSig!;
  };
  /**
   *
   * Combine Shares from network public key set and signature shares
   *
   * @param { NodeBlsSigningShare } signatureShares
   *
   * @returns { string } final JWT (convert the sig to base64 and append to the jwt)
   *
   */
  #combineSharesAndGetJWT = (
    signatureShares: NodeBlsSigningShare[],
    requestId: string = ''
  ): string => {
    // ========== Shares Validations ==========
    // -- sanity check
    if (
      !signatureShares.every(
        (val: any, i: any, arr: any) => val.unsignedJwt === arr[0].unsignedJwt
      )
    ) {
      const msg =
        'Unsigned JWT is not the same from all the nodes.  This means the combined signature will be bad because the nodes signed the wrong things';
      logErrorWithRequestId(requestId, msg);
    }

    // ========== Sorting ==========
    // -- sort the sig shares by share index.  this is important when combining the shares.
    signatureShares.sort((a: any, b: any) => a.shareIndex - b.shareIndex);

    // ========== Combine Shares ==========
    const signature = combineSignatureShares(
      signatureShares.map((s) => s.signatureShare)
    );

    logWithRequestId(requestId, 'signature is', signature);

    const unsignedJwt = mostCommonString(
      signatureShares.map((s: any) => s.unsignedJwt)
    );

    // ========== Result ==========
    // convert the sig to base64 and append to the jwt
    const finalJwt: string = `${unsignedJwt}.${uint8arrayToString(
      uint8arrayFromString(signature, 'base16'),
      'base64urlpad'
    )}`;

    return finalJwt;
  };
  /**
   *
   * Get Session Key URI eg. lit:session:0x1234
   *
   * @param publicKey is the public key of the session key
   * @returns { string } the session key uri
   */
  #getSessionKeyUri = (publicKey: string): string => {
    return LIT_SESSION_KEY_URI + publicKey;
  };
  /**
   * Generates a promise by sending a command to the Lit node
   *
   * @param url - The URL to send the command to.
   * @param params - The parameters to include in the command.
   * @param requestId - The ID of the request.
   * @returns A promise that resolves with the response from the server.
   */
  #generatePromise = async (
    url: string,
    params: any,
    requestId: string
  ): Promise<NodeCommandResponse> => {
    return await this._sendCommandToNode({
      url,
      data: params,
      requestId,
    });
  };
  // ========== Rate Limit NFT ==========

  // TODO: Add support for browser feature/lit-2321-js-sdk-add-browser-support-for-createCapacityDelegationAuthSig
  /**
   * Creates a capacity delegation authSig.
   *
   * @param params - The parameters for creating the capacity delegation authSig.
   * @returns A promise that resolves to the capacity delegation authSig.
   * @throws An error if the dAppOwnerWallet is not provided.
   */
  createCapacityDelegationAuthSig = async (
    params: CapacityCreditsReq
  ): Promise<CapacityCreditsRes> => {
    // -- validate
    if (!params.dAppOwnerWallet) {
      throw new Error('dAppOwnerWallet must exist');
    }

    // Useful log for debugging
    if (!params.delegateeAddresses || params.delegateeAddresses.length === 0) {
      log(
        `[createCapacityDelegationAuthSig] 'delegateeAddresses' is an empty array. It means that no body can use it. However, if the 'delegateeAddresses' field is omitted, It means that the capability will not restrict access based on delegatee list, but it may still enforce other restrictions such as usage limits (uses) and specific NFT IDs (nft_id).`
      );
    }

    // -- This is the owner address who holds the Capacity Credits NFT token and wants to delegate its
    // usage to a list of delegatee addresses
    const dAppOwnerWalletAddress = ethers.utils.getAddress(
      await params.dAppOwnerWallet.getAddress()
    );

    // -- if it's not ready yet, then connect
    if (!this.ready) {
      await this.connect();
    }

    const nonce = await this.getLatestBlockhash();
    const siweMessage = await createSiweMessageWithCapacityDelegation({
      uri: 'lit:capability:delegation',
      litNodeClient: this,
      walletAddress: dAppOwnerWalletAddress,
      nonce: nonce,
      expiration: params.expiration,
      domain: params.domain,
      statement: params.statement,

      // -- capacity delegation specific configuration
      uses: params.uses,
      delegateeAddresses: params.delegateeAddresses,
      capacityTokenId: params.capacityTokenId,
    });

    const authSig = await generateAuthSig({
      signer: params.dAppOwnerWallet,
      toSign: siweMessage,
    });

    return { capacityDelegationAuthSig: authSig };
  };

  // ==================== SESSIONS ====================
  /**
   * Try to get the session key in the local storage,
   * if not, generates one.
   * @return { SessionKeyPair } session key pair
   */
  getSessionKey = (): SessionKeyPair => {
    const storageKey = LOCAL_STORAGE_KEYS.SESSION_KEY;
    const storedSessionKeyOrError = getStorageItem(storageKey);

    if (
      storedSessionKeyOrError.type === EITHER_TYPE.ERROR ||
      !storedSessionKeyOrError.result ||
      storedSessionKeyOrError.result === ''
    ) {
      console.warn(
        `Storage key "${storageKey}" is missing. Not a problem. Contiune...`
      );

      // Generate new one
      const newSessionKey = generateSessionKeyPair();

      // (TRY) to set to local storage
      try {
        localStorage.setItem(storageKey, JSON.stringify(newSessionKey));
      } catch (e) {
        log(
          `[getSessionKey] Localstorage not available.Not a problem.Contiune...`
        );
      }

      return newSessionKey;
    } else {
      return JSON.parse(storedSessionKeyOrError.result as string);
    }
  };

  /**
   * Check if a given object is of type SessionKeyPair.
   *
   * @param obj - The object to check.
   * @returns True if the object is of type SessionKeyPair.
   */
  isSessionKeyPair(obj: any): obj is SessionKeyPair {
    return (
      typeof obj === 'object' &&
      'publicKey' in obj &&
      'secretKey' in obj &&
      typeof obj.publicKey === 'string' &&
      typeof obj.secretKey === 'string'
    );
  }

  /**
   * Generates wildcard capability for each of the LIT resources
   * specified.
   * @param litResources is an array of LIT resources
   * @param addAllCapabilities is a boolean that specifies whether to add all capabilities for each resource
   */
  static async generateSessionCapabilityObjectWithWildcards(
    litResources: ILitResource[],
    addAllCapabilities?: boolean
  ): Promise<ISessionCapabilityObject> {
    const sessionCapabilityObject = new RecapSessionCapabilityObject({}, []);

    // disable for now
    const _addAllCapabilities = addAllCapabilities ?? false;

    if (_addAllCapabilities) {
      for (const litResource of litResources) {
        sessionCapabilityObject.addAllCapabilitiesForResource(litResource);
      }
    }

    return sessionCapabilityObject;
  }

  // backward compatibility
  async generateSessionCapabilityObjectWithWildcards(
    litResources: ILitResource[]
  ): Promise<ISessionCapabilityObject> {
    return await LitNodeClientNodeJs.generateSessionCapabilityObjectWithWildcards(
      litResources
    );
  }

  /**
   * Get expiration for session default time is 1 day / 24 hours
   */
  static getExpiration = () => {
    return new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
  };

  // backward compatibility
  getExpiration = () => {
    return LitNodeClientNodeJs.getExpiration();
  };

  // ========== Promise Handlers ==========
  getIpfsId = async ({
    dataToHash,
    sessionSigs,
  }: {
    dataToHash: string;
    sessionSigs: SessionSigsMap;
    debug?: boolean;
  }) => {
    const res = await this.executeJs({
      ipfsId: LIT_ACTION_IPFS_HASH,
      sessionSigs,
      jsParams: {
        dataToHash,
      },
    }).catch((e) => {
      logError('Error getting IPFS ID', e);
      throw e;
    });

    let data;

    if (typeof res.response === 'string') {
      try {
        data = JSON.parse(res.response).res;
      } catch (e) {
        data = res.response;
      }
    }

    if (!data.success) {
      logError('Error getting IPFS ID', data.data);
    }

    return data.data;
  };

  /**
   * Run lit action on a single deterministicly selected node. It's important that the nodes use the same deterministic selection algorithm.
   *
   * Lit Action: dataToHash -> IPFS CID
   * QmUjX8MW6StQ7NKNdaS6g4RMkvN5hcgtKmEi8Mca6oX4t3
   *
   * @param { ExecuteJsProps } params
   *
   * @returns { Promise<SuccessNodePromises<T> | RejectedNodePromises> }
   *
   */
  runOnTargetedNodes = async (
    params: JsonExecutionSdkParamsTargetNode
  ): Promise<
    SuccessNodePromises<NodeCommandResponse> | RejectedNodePromises
  > => {
    log('running runOnTargetedNodes:', params.targetNodeRange);

    if (!params.targetNodeRange) {
      return throwError({
        message: 'targetNodeRange is required',
        errorKind: LIT_ERROR.INVALID_PARAM_TYPE.kind,
        errorCode: LIT_ERROR.INVALID_PARAM_TYPE.name,
      });
    }

    // determine which node to run on
    const ipfsId = await this.getIpfsId({
      dataToHash: params.code!,
      sessionSigs: params.sessionSigs,
    });

    // select targetNodeRange number of random index of the bootstrapUrls.length
    const randomSelectedNodeIndexes: number[] = [];

    let nodeCounter = 0;

    while (randomSelectedNodeIndexes.length < params.targetNodeRange) {
      const str = `${nodeCounter}:${ipfsId.toString()}`;
      const cidBuffer = Buffer.from(str);
      const hash = sha256(cidBuffer);
      const hashAsNumber = BigNumber.from(hash);

      const nodeIndex = hashAsNumber
        .mod(this.config.bootstrapUrls.length)
        .toNumber();

      log('nodeIndex:', nodeIndex);

      // must be unique & less than bootstrapUrls.length
      if (
        !randomSelectedNodeIndexes.includes(nodeIndex) &&
        nodeIndex < this.config.bootstrapUrls.length
      ) {
        randomSelectedNodeIndexes.push(nodeIndex);
      }
      nodeCounter++;
    }

    log('Final Selected Indexes:', randomSelectedNodeIndexes);

    const wrapper = async (
      id: string
    ): Promise<SuccessNodePromises<any> | RejectedNodePromises> => {
      const nodePromises = [];

      for (let i = 0; i < randomSelectedNodeIndexes.length; i++) {
        // should we mix in the jsParams?  to do this, we need a canonical way to serialize the jsParams object that will be identical in rust.
        // const jsParams = params.jsParams || {};
        // const jsParamsString = JSON.stringify(jsParams);

        const nodeIndex = randomSelectedNodeIndexes[i];

        // FIXME: we are using this.config.bootstrapUrls to pick the selected node, but we
        // should be using something like the list of nodes from the staking contract
        // because the staking nodes can change, and the rust code will use the same list
        const url = this.config.bootstrapUrls[nodeIndex];

        log(`running on node ${nodeIndex} at ${url}`);

        // -- choose the right signature
        const sessionSig = this._getSessionSigByUrl({
          sessionSigs: params.sessionSigs,
          url,
        });

        const reqBody: JsonExecutionRequestTargetNode = {
          ...params,
          targetNodeRange: params.targetNodeRange,
          authSig: sessionSig,
        };

        // this return { url: string, data: JsonRequest }
        // const singleNodePromise = this.getJsExecutionShares(url, reqBody, id);
        const singleNodePromise = this._sendCommandToNode({
          url: url,
          data: params,
          requestId: id,
        });

        nodePromises.push(singleNodePromise);
      }

      const handledPromise = (await this._handleNodePromises(
        nodePromises,
        id,
        params.targetNodeRange
      )) as SuccessNodePromises<NodeCommandResponse> | RejectedNodePromises;

      // -- handle response
      return handledPromise;
    };

    return executeWithRetry<RejectedNodePromises | SuccessNodePromises<any>>(
      wrapper,
      (_error: any, _requestId: string, isFinal: boolean) => {
        if (!isFinal) {
          logError('error has occured, attempting to retry');
        }
      },
      this.config.retryTolerance
    );
  };

  /**
   *
   * Encrypt data using the LIT network public key.
   *
   * @param { EncryptSdkParams } params
   * @param params.dataToEncrypt - The data to encrypt
   * @param params.accessControlConditions - (optional) The access control conditions for the data
   * @param params.evmContractConditions - (optional) The EVM contract conditions for the data
   * @param params.solRpcConditions - (optional) The Solidity RPC conditions for the data
   * @param params.unifiedAccessControlConditions - (optional) The unified access control conditions for the data
   *
   * @return { Promise<EncryptResponse> } The encrypted ciphertext and the hash of the data
   *
   * @throws { Error } if the LIT node client is not ready
   * @throws { Error } if the subnetPubKey is null
   */
  encrypt = async (params: EncryptSdkParams): Promise<EncryptResponse> => {
    // ========== Validate Params ==========
    // -- validate if it's ready
    if (!this.ready) {
      const message =
        '6 LitNodeClient is not ready.  Please call await litNodeClient.connect() first.';
      throwError({
        message,
        errorKind: LIT_ERROR.LIT_NODE_CLIENT_NOT_READY_ERROR.kind,
        errorCode: LIT_ERROR.LIT_NODE_CLIENT_NOT_READY_ERROR.name,
      });
    }

    // -- validate if this.subnetPubKey is null
    if (!this.subnetPubKey) {
      const message = 'subnetPubKey cannot be null';
      return throwError({
        message,
        errorKind: LIT_ERROR.LIT_NODE_CLIENT_NOT_READY_ERROR.kind,
        errorCode: LIT_ERROR.LIT_NODE_CLIENT_NOT_READY_ERROR.name,
      });
    }

    const paramsIsSafe = safeParams({
      functionName: 'encrypt',
      params,
    });

    if (!paramsIsSafe) {
      return throwError({
        message: `You must provide either accessControlConditions or evmContractConditions or solRpcConditions or unifiedAccessControlConditions`,
        errorKind: LIT_ERROR.INVALID_ARGUMENT_EXCEPTION.kind,
        errorCode: LIT_ERROR.INVALID_ARGUMENT_EXCEPTION.name,
      });
    }

    // ========== Validate Access Control Conditions Schema ==========
    await this.validateAccessControlConditionsSchema(params);

    // ========== Hashing Access Control Conditions =========
    // hash the access control conditions
    const hashOfConditions: ArrayBuffer | undefined =
      await this.getHashedAccessControlConditions(params);

    if (!hashOfConditions) {
      return throwError({
        message: `You must provide either accessControlConditions or evmContractConditions or solRpcConditions or unifiedAccessControlConditions`,
        errorKind: LIT_ERROR.INVALID_ARGUMENT_EXCEPTION.kind,
        errorCode: LIT_ERROR.INVALID_ARGUMENT_EXCEPTION.name,
      });
    }

    const hashOfConditionsStr = uint8arrayToString(
      new Uint8Array(hashOfConditions),
      'base16'
    );

    // ========== Hashing Private Data ==========
    // hash the private data
    const hashOfPrivateData = await crypto.subtle.digest(
      'SHA-256',
      params.dataToEncrypt
    );
    const hashOfPrivateDataStr = uint8arrayToString(
      new Uint8Array(hashOfPrivateData),
      'base16'
    );

    // ========== Assemble identity parameter ==========
    const identityParam = this.#getIdentityParamForEncryption(
      hashOfConditionsStr,
      hashOfPrivateDataStr
    );

    // ========== Encrypt ==========
    const ciphertext = encrypt(
      this.subnetPubKey,
      params.dataToEncrypt,
      uint8arrayFromString(identityParam, 'utf8')
    );

    return { ciphertext, dataToEncryptHash: hashOfPrivateDataStr };
  };

  /** ============================== SESSION ============================== */
  /**
   * Get session signatures for a set of resources
   *
   * High level, how this works:
   * 1. Generate or retrieve session key
   * 2. Generate or retrieve the wallet signature of the session key
   * 3. Sign the specific resources with the session key
   *
   * Note: When generating session signatures for different PKPs or auth methods,
   * be sure to call disconnectWeb3 to clear auth signatures stored in local storage
   *
   * @param { GetSessionSigsProps } params
   * 
   * @example
   * 
   * ```ts
   * import { LitPKPResource, LitActionResource } from "@lit-protocol/auth-helpers";
import { LitAbility } from "@lit-protocol/types";
import { logWithRequestId } from '../../../misc/src/lib/misc';

const resourceAbilityRequests = [
    {
      resource: new LitPKPResource("*"),
      ability: LitAbility.PKPSigning,
    },
    {
      resource: new LitActionResource("*"),
      ability: LitAbility.LitActionExecution,
    },
  ];
   * ```
   */
  getSessionSigs = async (
    params: GetSessionSigsProps
  ): Promise<SessionSigsMap> => {
    // -- prepare
    // Try to get it from local storage, if not generates one~
    const sessionKey = params.sessionKey ?? this.getSessionKey();

    const sessionKeyUri = this.#getSessionKeyUri(sessionKey.publicKey);

    // First get or generate the session capability object for the specified resources.
    const sessionCapabilityObject = params.sessionCapabilityObject
      ? params.sessionCapabilityObject
      : await this.generateSessionCapabilityObjectWithWildcards(
          params.resourceAbilityRequests.map((r) => r.resource)
        );
    const expiration = params.expiration || LitNodeClientNodeJs.getExpiration();

    if (!this.latestBlockhash) {
      throwError({
        message: 'Eth Blockhash is undefined.',
        errorKind: LIT_ERROR.INVALID_ETH_BLOCKHASH.kind,
        errorCode: LIT_ERROR.INVALID_ETH_BLOCKHASH.name,
      });
    }
    const nonce = this.latestBlockhash!;

    // -- (TRY) to get the wallet signature
    let authSig = await this.#getWalletSig({
      authNeededCallback: params.authNeededCallback,
      chain: params.chain || 'ethereum',
      sessionCapabilityObject,
      switchChain: params.switchChain,
      expiration: expiration,
      sessionKey: sessionKey,
      sessionKeyUri: sessionKeyUri,
      nonce,

      // -- for recap
      resourceAbilityRequests: params.resourceAbilityRequests,

      // -- optional fields
      ...(params.litActionCode && { litActionCode: params.litActionCode }),
      ...(params.litActionIpfsId && {
        litActionIpfsId: params.litActionIpfsId,
      }),
      ...(params.jsParams && { jsParams: params.jsParams }),
    });

    const needToResignSessionKey = await this.#checkNeedToResignSessionKey({
      authSig,
      sessionKeyUri,
      resourceAbilityRequests: params.resourceAbilityRequests,
    });

    // -- (CHECK) if we need to resign the session key
    if (needToResignSessionKey) {
      log('need to re-sign session key.  Signing...');
      authSig = await this.#authCallbackAndUpdateStorageItem({
        authCallback: params.authNeededCallback,
        authCallbackParams: {
          chain: params.chain || 'ethereum',
          statement: sessionCapabilityObject.statement,
          resources: [sessionCapabilityObject.encodeAsSiweResource()],
          switchChain: params.switchChain,
          expiration,
          sessionKey: sessionKey,
          uri: sessionKeyUri,
          nonce,
          resourceAbilityRequests: params.resourceAbilityRequests,

          // -- optional fields
          ...(params.litActionCode && { litActionCode: params.litActionCode }),
          ...(params.litActionIpfsId && {
            litActionIpfsId: params.litActionIpfsId,
          }),
          ...(params.jsParams && { jsParams: params.jsParams }),
        },
      });
    }

    if (
      authSig.address === '' ||
      authSig.derivedVia === '' ||
      authSig.sig === '' ||
      authSig.signedMessage === ''
    ) {
      throwError({
        message: 'No wallet signature found',
        errorKind: LIT_ERROR.WALLET_SIGNATURE_NOT_FOUND_ERROR.kind,
        errorCode: LIT_ERROR.WALLET_SIGNATURE_NOT_FOUND_ERROR.name,
      });
      // @ts-ignore - we throw an error above, so below should never be reached
      return;
    }

    // ===== AFTER we have Valid Signed Session Key =====
    // - Let's sign the resources with the session key
    // - 5 minutes is the default expiration for a session signature
    // - Because we can generate a new session sig every time the user wants to access a resource without prompting them to sign with their wallet
    const sessionExpiration =
      expiration ?? new Date(Date.now() + 1000 * 60 * 5).toISOString();

    const capabilities = params.capacityDelegationAuthSig
      ? [
          ...(params.capabilityAuthSigs ?? []),
          params.capacityDelegationAuthSig,
          authSig,
        ]
      : [...(params.capabilityAuthSigs ?? []), authSig];

    const signingTemplate = {
      sessionKey: sessionKey.publicKey,
      resourceAbilityRequests: params.resourceAbilityRequests,
      capabilities,
      issuedAt: new Date().toISOString(),
      expiration: sessionExpiration,
    };

    const signatures: SessionSigsMap = {};

    this.connectedNodes.forEach((nodeAddress: string) => {
      const toSign: SessionSigningTemplate = {
        ...signingTemplate,
        nodeAddress,
      };

      const signedMessage = JSON.stringify(toSign);

      const uint8arrayKey = uint8arrayFromString(
        sessionKey.secretKey,
        'base16'
      );

      const uint8arrayMessage = uint8arrayFromString(signedMessage, 'utf8');
      const signature = nacl.sign.detached(uint8arrayMessage, uint8arrayKey);

      signatures[nodeAddress] = {
        sig: uint8arrayToString(signature, 'base16'),
        derivedVia: 'litSessionSignViaNacl',
        signedMessage: signedMessage,
        address: sessionKey.publicKey,
        algo: 'ed25519',
      };
    });

    log('signatures:', signatures);

    return signatures;
  };

  /**
   * Retrieves the PKP sessionSigs.
   *
   * @param params - The parameters for retrieving the PKP sessionSigs.
   * @returns A promise that resolves to the PKP sessionSigs.
   * @throws An error if any of the required parameters are missing or if `litActionCode` and `ipfsId` exist at the same time.
   */
  getPkpSessionSigs = async (params: GetPkpSessionSigs) => {
    const chain = params?.chain || 'ethereum';

    const pkpSessionSigs = this.getSessionSigs({
      chain,
      ...params,
      authNeededCallback: async (props: AuthCallbackParams) => {
        // -- validate
        if (!props.expiration) {
          throw new Error(
            '[getPkpSessionSigs/callback] expiration is required'
          );
        }

        if (!props.resources) {
          throw new Error('[getPkpSessionSigs/callback]resources is required');
        }

        if (!props.resourceAbilityRequests) {
          throw new Error(
            '[getPkpSessionSigs/callback]resourceAbilityRequests is required'
          );
        }

        // lit action code and ipfs id cannot exist at the same time
        if (props.litActionCode && props.litActionIpfsId) {
          throw new Error(
            '[getPkpSessionSigs/callback]litActionCode and litActionIpfsId cannot exist at the same time'
          );
        }

        /**
         * We must provide an empty array for authMethods even if we are not using any auth methods.
         * So that the nodes can serialize the request correctly.
         */
        const authMethods = params.authMethods || [];

        const response = await this.signSessionKey({
          sessionKey: props.sessionKey,
          statement: props.statement || 'Some custom statement.',
          authMethods: [...authMethods],
          pkpPublicKey: params.pkpPublicKey,
          expiration: props.expiration,
          resources: props.resources,
          chainId: 1,

          // -- required fields
          resourceAbilityRequests: props.resourceAbilityRequests,

          // -- optional fields
          ...(props.litActionCode && { litActionCode: props.litActionCode }),
          ...(props.litActionIpfsId && {
            litActionIpfsId: props.litActionIpfsId,
          }),
          ...(props.jsParams && { jsParams: props.jsParams }),
        });

        return response.authSig;
      },
    });

    return pkpSessionSigs;
  };

  /**
   * Retrieves session signatures specifically for Lit Actions.
   * Unlike `getPkpSessionSigs`, this function requires either `litActionCode` or `litActionIpfsId`, and `jsParams` must be provided.
   *
   * @param params - The parameters required for retrieving the session signatures.
   * @returns A promise that resolves with the session signatures.
   */
  getLitActionSessionSigs = async (params: GetLitActionSessionSigs) => {
    // Check if either litActionCode or litActionIpfsId is provided
    if (!params.litActionCode && !params.litActionIpfsId) {
      throw new Error(
        "Either 'litActionCode' or 'litActionIpfsId' must be provided."
      );
    }

    // Check if jsParams is provided
    if (!params.jsParams) {
      throw new Error("'jsParams' is required.");
    }

    return this.getPkpSessionSigs(params);
  };

  /** ============================== END POINTS ============================== */
  /**
   * Sign a session public key using a PKP, which generates an authSig.
   * Endpoint: /web/sign_session_key endpoint.
   * @returns {Object} An object containing the resulting signature.
   */
  signSessionKey = async (
    params: SignSessionKeyProp
  ): Promise<SignSessionKeyResponse> => {
    log(`[signSessionKey] params:`, params);

    // ========== Validate Params ==========
    // -- validate: If it's NOT ready
    if (!this.ready) {
      const message =
        '[signSessionKey] ]LitNodeClient is not ready.  Please call await litNodeClient.connect() first.';

      throwError({
        message,
        errorKind: LIT_ERROR.LIT_NODE_CLIENT_NOT_READY_ERROR.kind,
        errorCode: LIT_ERROR.LIT_NODE_CLIENT_NOT_READY_ERROR.name,
      });
    }

    // -- construct SIWE message that will be signed by node to generate an authSig.
    const _expiration =
      params.expiration ||
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // Try to get it from local storage, if not generates one~
    const sessionKey: SessionKeyPair =
      params.sessionKey ?? this.getSessionKey();
    const sessionKeyUri = LIT_SESSION_KEY_URI + sessionKey.publicKey;

    log(
      `[signSessionKey] sessionKeyUri is not found in params, generating a new one`,
      sessionKeyUri
    );

    if (!sessionKeyUri) {
      throw new Error(
        '[signSessionKey] sessionKeyUri is not defined. Please provide a sessionKeyUri or a sessionKey.'
      );
    }

    // Compute the address from the public key if it's provided. Otherwise, the node will compute it.
    const pkpEthAddress = (function () {
      // prefix '0x' if it's not already prefixed
      params.pkpPublicKey = hexPrefixed(params.pkpPublicKey!);

      if (params.pkpPublicKey) return computeAddress(params.pkpPublicKey);

      // This will be populated by the node, using dummy value for now.
      return '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    })();

    let siwe_statement = 'Lit Protocol PKP session signature';
    if (params.statement) {
      siwe_statement += ' ' + params.statement;
      log(`[signSessionKey] statement found in params: "${params.statement}"`);
    }

    let siweMessage;

    const siweParams = {
      domain: params?.domain || globalThis.location?.host || 'litprotocol.com',
      walletAddress: pkpEthAddress,
      statement: siwe_statement,
      uri: sessionKeyUri,
      version: '1',
      chainId: params.chainId ?? 1,
      expiration: _expiration,
      nonce: this.latestBlockhash!,
    };

    if (params.resourceAbilityRequests) {
      siweMessage = await createSiweMessageWithRecaps({
        ...siweParams,
        resources: params.resourceAbilityRequests,
        litNodeClient: this,
      });
    } else {
      siweMessage = await createSiweMessage(siweParams);
    }

    // ========== Get Node Promises ==========
    // -- fetch shares from nodes
    const body: JsonSignSessionKeyRequestV1 = {
      sessionKey: sessionKeyUri,
      authMethods: params.authMethods,
      ...(params?.pkpPublicKey && { pkpPublicKey: params.pkpPublicKey }),
      siweMessage: siweMessage,
      curveType: LIT_CURVE.BLS,

      // -- custom auths
      ...(params?.litActionIpfsId && {
        litActionIpfsId: params.litActionIpfsId,
      }),
      ...(params?.litActionCode && { code: params.litActionCode }),
      ...(params?.jsParams && { jsParams: params.jsParams }),
      ...(this.currentEpochNumber && { epoch: this.currentEpochNumber }),
    };

    log(`[signSessionKey] body:`, body);

    const wrapper = async (
      id: string
    ): Promise<SuccessNodePromises<any> | RejectedNodePromises> => {
      logWithRequestId(id, 'signSessionKey body', body);
      const nodePromises = this._getNodePromises((url: string) => {
        const reqBody: JsonSignSessionKeyRequestV1 = body;

        const urlWithPath = composeLitUrl({
          url,
          endpoint: LIT_ENDPOINT.SIGN_SESSION_KEY,
        });

        return this.#generatePromise(urlWithPath, reqBody, id);
      });

      // -- resolve promises
      let res;
      try {
        res = await this._handleNodePromises(
          nodePromises,
          id,
          this.connectedNodes.size
        );
        log('signSessionKey node promises:', res);
      } catch (e) {
        throw new Error(`Error when handling node promises: ${e}`);
      }
      return res;
    };

    const res = await executeWithRetry<
      RejectedNodePromises | SuccessNodePromises<any>
    >(
      wrapper,
      (_error: any, _requestId: string, isFinal: boolean) => {
        if (!isFinal) {
          logError('an error occured, attempting to retry ');
        }
      },
      this.config.retryTolerance
    );

    const requestId = res.requestId;
    logWithRequestId(requestId, 'handleNodePromises res:', res);

    // -- case: promises rejected
    if (!this.#isSuccessNodePromises(res)) {
      this._throwNodeError(res as RejectedNodePromises, requestId);
      return {} as SignSessionKeyResponse;
    }

    const responseData: BlsResponseData[] = res.values;
    logWithRequestId(
      requestId,
      '[signSessionKey] responseData',
      JSON.stringify(responseData, null, 2)
    );

    // ========== Extract shares from response data ==========
    // -- 1. combine signed data as a list, and get the signatures from it
    let curveType = responseData[0]?.curveType;

    if (!curveType) {
      log(`[signSessionKey] curveType not found. Defaulting to ECDSA.`);
      curveType = 'ECDSA';
    }

    log(`[signSessionKey] curveType is "${curveType}"`);

    let signedDataList = responseData.map((s) => s.dataSigned);

    if (signedDataList.length <= 0) {
      const err = `[signSessionKey] signedDataList is empty.`;
      log(err);
      throw new Error(err);
    }

    logWithRequestId(
      requestId,
      '[signSessionKey] signedDataList',
      signedDataList
    );

    // -- checking if we have enough shares
    const validatedSignedDataList = responseData
      .map((data: BlsResponseData) => {
        // each of this field cannot be empty
        let requiredFields = [
          'signatureShare',
          'curveType',
          'shareIndex',
          'siweMessage',
          'dataSigned',
          'blsRootPubkey',
          'result',
        ];

        // check if all required fields are present
        for (const field of requiredFields) {
          const key: keyof BlsResponseData = field as keyof BlsResponseData;

          if (!data[key] || data[key] === '') {
            log(
              `[signSessionKey] Invalid signed data. "${field}" is missing. Not a problem, we only need ${this.config.minNodeCount} nodes to sign the session key.`
            );
            return null;
          }
        }

        if (!data.signatureShare.ProofOfPossession) {
          const err = `[signSessionKey] Invalid signed data. "ProofOfPossession" is missing.`;
          log(err);
          throw new Error(err);
        }

        return data;
      })
      .filter((item) => item !== null);

    logWithRequestId(
      requestId,
      '[signSessionKey] requested length:',
      signedDataList.length
    );
    logWithRequestId(
      requestId,
      '[signSessionKey] validated length:',
      validatedSignedDataList.length
    );
    logWithRequestId(
      requestId,
      '[signSessionKey] minimum required length:',
      this.config.minNodeCount
    );
    if (validatedSignedDataList.length < this.config.minNodeCount) {
      throw new Error(
        `[signSessionKey] not enough nodes signed the session key.  Expected ${this.config.minNodeCount}, got ${validatedSignedDataList.length}`
      );
    }

    const blsSignedData: BlsResponseData[] =
      validatedSignedDataList as BlsResponseData[];

    const sigType = mostCommonString(blsSignedData.map((s) => s.curveType));
    log(`[signSessionKey] sigType:`, sigType);

    const signatureShares = getBlsSignatures(blsSignedData);

    log(`[signSessionKey] signatureShares:`, signatureShares);

    const blsCombinedSignature = blsSdk.combine_signature_shares(
      signatureShares.map((s) => JSON.stringify(s))
    );

    log(`[signSessionKey] blsCombinedSignature:`, blsCombinedSignature);

    const publicKey = removeHexPrefix(params.pkpPublicKey);
    log(`[signSessionKey] publicKey:`, publicKey);

    const dataSigned = mostCommonString(
      blsSignedData.map((s: any) => s.dataSigned)
    );
    log(`[signSessionKey] dataSigned:`, dataSigned);

    const mostCommonSiweMessage = mostCommonString(
      blsSignedData.map((s: any) => s.siweMessage)
    );

    log(`[signSessionKey] mostCommonSiweMessage:`, mostCommonSiweMessage);

    const signedMessage = normalizeAndStringify(mostCommonSiweMessage);

    log(`[signSessionKey] signedMessage:`, signedMessage);

    const signSessionKeyRes: SignSessionKeyResponse = {
      authSig: {
        sig: JSON.stringify({
          ProofOfPossession: blsCombinedSignature,
        }),
        algo: 'LIT_BLS',
        derivedVia: 'lit.bls',
        signedMessage,
        address: computeAddress(hexPrefixed(publicKey)),
      },
      pkpPublicKey: publicKey,
    };

    return signSessionKeyRes;
  };

  /**
   *
   * Execute JS on the nodes and combine and return any resulting signatures
   * Endpoint: /web/execute
   * @param { JsonExecutionSdkParams } params
   *
   * @returns { ExecuteJsResponse }
   *
   */
  executeJs = async (
    params: JsonExecutionSdkParams
  ): Promise<ExecuteJsResponse> => {
    // ========== Validate Params ==========
    if (!this.ready) {
      const message =
        '[executeJs] LitNodeClient is not ready.  Please call await litNodeClient.connect() first.';

      throwError({
        message,
        errorKind: LIT_ERROR.LIT_NODE_CLIENT_NOT_READY_ERROR.kind,
        errorCode: LIT_ERROR.LIT_NODE_CLIENT_NOT_READY_ERROR.name,
      });
    }

    const paramsIsSafe = safeParams({
      functionName: 'executeJs',
      params: params,
    });

    if (!paramsIsSafe) {
      return throwError({
        message: 'executeJs params are not valid',
        errorKind: LIT_ERROR.INVALID_PARAM_TYPE.kind,
        errorCode: LIT_ERROR.INVALID_PARAM_TYPE.name,
      });
    }

    // Format the params
    const formattedParams: JsonExecutionSdkParams = {
      ...params,
      ...(params.jsParams && { jsParams: normalizeJsParams(params.jsParams) }),
      ...(params.code && { code: encodeCode(params.code) }),
    };

    // ========== Get Node Promises ==========
    // Handle promises for commands sent to Lit nodes
    const wrapper = async (
      requestId: string
    ): Promise<SuccessNodePromises<any> | RejectedNodePromises> => {
      const nodePromises = this._getNodePromises(async (url: string) => {
        // -- choose the right signature
        const sessionSig = this._getSessionSigByUrl({
          sessionSigs: formattedParams.sessionSigs,
          url,
        });

        const reqBody: JsonExecutionRequest = {
          ...formattedParams,
          authSig: sessionSig,
        };

        const urlWithPath = composeLitUrl({
          url,
          endpoint: LIT_ENDPOINT.EXECUTE_JS,
        });

        return this.#generatePromise(urlWithPath, reqBody, requestId);
      });

      // -- resolve promises
      const res = await this._handleNodePromises(
        nodePromises,
        requestId,
        this.connectedNodes.size
      );

      return res;
    }; // wrapper end

    // ========== Execute with Retry ==========
    const res = await executeWithRetry<
      RejectedNodePromises | SuccessNodePromises<any>
    >(
      wrapper,
      (error: any, requestId: string, isFinal: boolean) => {
        logError('an error occured, attempting to retry operation');
      },
      this.config.retryTolerance
    );

    // ========== Handle Response ==========
    const requestId = res.requestId;

    // -- case: promises rejected
    if (!res.success) {
      this._throwNodeError(res as RejectedNodePromises, requestId);
    }

    // -- case: promises success (TODO: check the keys of "values")
    const responseData = (res as SuccessNodePromises<NodeShare>).values;

    logWithRequestId(
      requestId,
      'executeJs responseData from node : ',
      JSON.stringify(responseData, null, 2)
    );

    // -- find the responseData that has the most common response
    const mostCommonResponse = findMostCommonResponse(
      responseData
    ) as NodeShare;

    const responseFromStrategy: any = processLitActionResponseStrategy(
      responseData,
      params.responseStrategy ?? { strategy: 'leastCommon' }
    );
    mostCommonResponse.response = responseFromStrategy;

    const isSuccess = mostCommonResponse.success;
    const hasSignedData = Object.keys(mostCommonResponse.signedData).length > 0;
    const hasClaimData = Object.keys(mostCommonResponse.claimData).length > 0;

    // -- we must also check for claim responses as a user may have submitted for a claim and signatures must be aggregated before returning
    if (isSuccess && !hasSignedData && !hasClaimData) {
      return mostCommonResponse as unknown as ExecuteJsResponse;
    }

    // -- in the case where we are not signing anything on Lit action and using it as purely serverless function
    if (!hasSignedData && !hasClaimData) {
      return {
        claims: {},
        signatures: null,
        decryptions: [],
        response: mostCommonResponse.response,
        logs: mostCommonResponse.logs,
      } as ExecuteJsNoSigningResponse;
    }

    // ========== Extract shares from response data ==========

    // -- 1. combine signed data as a list, and get the signatures from it
    const signedDataList = responseData.map((r) => {
      return removeDoubleQuotes(r.signedData);
    });

    logWithRequestId(
      requestId,
      'signatures shares to combine: ',
      signedDataList
    );

    const signatures = getSignatures({
      requestId,
      networkPubKeySet: this.networkPubKeySet,
      minNodeCount: this.config.minNodeCount,
      signedData: signedDataList,
    });

    // -- 2. combine responses as a string, and parse it as JSON if possible
    const parsedResponse = parseAsJsonOrString(mostCommonResponse.response);

    // -- 3. combine logs
    const mostCommonLogs: string = mostCommonString(
      responseData.map((r: NodeLog) => r.logs)
    );

    // -- 4. combine claims
    const claimsList = getClaimsList(responseData);
    const claims = claimsList.length > 0 ? getClaims(claimsList) : undefined;

    // ========== Result ==========
    const returnVal: ExecuteJsResponse = {
      claims,
      signatures,
      // decryptions: [],
      response: parsedResponse,
      logs: mostCommonLogs,
    };

    log('returnVal:', returnVal);

    return returnVal;
  };

  /**
   * Use PKP to sign
   *
   * Endpoint: /web/pkp/sign
   *
   * @param { JsonPkpSignSdkParams } params
   * @param params.toSign - The data to sign
   * @param params.pubKey - The public key to sign with
   * @param params.sessionSigs - The session signatures to use
   * @param params.authMethods - (optional) The auth methods to use
   */
  pkpSign = async (params: JsonPkpSignSdkParams): Promise<SigResponse> => {
    // -- validate required params
    const requiredParamKeys = ['toSign', 'pubKey'];

    (requiredParamKeys as (keyof JsonPkpSignSdkParams)[]).forEach((key) => {
      if (!params[key]) {
        throwError({
          message: `"${key}" cannot be undefined, empty, or null. Please provide a valid value.`,
          errorKind: LIT_ERROR.PARAM_NULL_ERROR.kind,
          errorCode: LIT_ERROR.PARAM_NULL_ERROR.name,
        });
      }
    });

    // -- validate present of accepted auth methods
    if (
      !params.sessionSigs &&
      (!params.authMethods || params.authMethods.length <= 0)
    ) {
      throwError({
        message: `Either sessionSigs or authMethods (length > 0) must be present.`,
        errorKind: LIT_ERROR.PARAM_NULL_ERROR.kind,
        errorCode: LIT_ERROR.PARAM_NULL_ERROR.name,
      });
    }

    // ========== Get Node Promises ==========
    // Handle promises for commands sent to Lit nodes
    const wrapper = async (
      id: string
    ): Promise<SuccessNodePromises<any> | RejectedNodePromises> => {
      const nodePromises = this._getNodePromises((url: string) => {
        // -- get the session sig from the url key
        const sessionSig = this._getSessionSigByUrl({
          sessionSigs: params.sessionSigs,
          url,
        });

        const reqBody: JsonPkpSignRequest = {
          toSign: normalizeArray(params.toSign),
          pubkey: hexPrefixed(params.pubKey),
          authSig: sessionSig,

          // -- optional params
          ...(params.authMethods &&
            params.authMethods.length > 0 && {
              authMethods: params.authMethods,
            }),
        };

        logWithRequestId(id, 'reqBody:', reqBody);

        const urlWithPath = composeLitUrl({
          url,
          endpoint: LIT_ENDPOINT.PKP_SIGN,
        });

        return this.#generatePromise(urlWithPath, reqBody, id);
      });

      const res = await this._handleNodePromises(
        nodePromises,
        id,
        this.connectedNodes.size // ECDSA requires responses from all nodes, but only shares from minNodeCount.
      );
      return res;
    }; // wrapper end

    // ========== Execute with Retry ==========
    const res = await executeWithRetry<
      RejectedNodePromises | SuccessNodePromises<any>
    >(
      wrapper,
      (error: any, requestId: string, isFinal: boolean) => {
        if (!isFinal) {
          logError('errror occured, retrying operation');
        }
      },
      this.config.retryTolerance
    );

    // ========== Handle Response ==========
    const requestId = res.requestId;

    // -- case: promises rejected
    if (!res.success) {
      this._throwNodeError(res as RejectedNodePromises, requestId);
    }

    // -- case: promises success (TODO: check the keys of "values")
    const responseData = (res as SuccessNodePromises<PKPSignShare>).values;

    logWithRequestId(
      requestId,
      'responseData',
      JSON.stringify(responseData, null, 2)
    );

    // ========== Extract shares from response data ==========
    // -- 1. combine signed data as a list, and get the signatures from it
    const signedDataList = parsePkpSignResponse(responseData);

    const signatures = getSignatures<{ signature: SigResponse }>({
      requestId,
      networkPubKeySet: this.networkPubKeySet,
      minNodeCount: this.config.minNodeCount,
      signedData: signedDataList,
    });

    logWithRequestId(requestId, `signature combination`, signatures);

    return signatures.signature; // only a single signature is ever present, so we just return it.
  };

  /**
   * Authenticates an Auth Method for claiming a Programmable Key Pair (PKP).
   * A {@link MintCallback} can be defined for custom on chain interactions
   * by default the callback will forward to a relay server for minting on chain.
   *
   * Endpoint: /web/pkp/claim
   *
   * @param {ClaimKeyRequest} params an Auth Method and {@link MintCallback}
   * @returns {Promise<ClaimKeyResponse>}
   */
  async claimKeyId(
    params: ClaimRequest<ClaimProcessor>
  ): Promise<ClaimKeyResponse> {
    if (!this.ready) {
      const message =
        'LitNodeClient is not ready.  Please call await litNodeClient.connect() first.';
      throwError({
        message,
        errorKind: LIT_ERROR.LIT_NODE_CLIENT_NOT_READY_ERROR.kind,
        errorCode: LIT_ERROR.LIT_NODE_CLIENT_NOT_READY_ERROR.name,
      });
    }

    if (params.authMethod.authMethodType == AuthMethodType.WebAuthn) {
      throwError({
        message:
          'Unsupported auth method type. Webauthn, and Lit Actions are not supported for claiming',
        errorKind: LIT_ERROR.LIT_NODE_CLIENT_NOT_READY_ERROR.kind,
        errorCode: LIT_ERROR.LIT_NODE_CLIENT_NOT_READY_ERROR.name,
      });
    }
    let requestId;
    const wrapper = async (
      id: string
    ): Promise<SuccessNodePromises<any> | RejectedNodePromises> => {
      const nodePromises = this._getNodePromises((url: string) => {
        if (!params.authMethod) {
          throw new Error('authMethod is required');
        }

        const reqBody: JsonPKPClaimKeyRequest = {
          authMethod: params.authMethod,
        };

        const urlWithPath = composeLitUrl({
          url,
          endpoint: LIT_ENDPOINT.PKP_CLAIM,
        });

        return this.#generatePromise(urlWithPath, reqBody, id);
      });

      const responseData = await this._handleNodePromises(
        nodePromises,
        id,
        this.connectedNodes.size
      );

      return responseData;
    };

    const responseData = await executeWithRetry<
      RejectedNodePromises | SuccessNodePromises<any>
    >(
      wrapper,
      (_error: any, _requestId: string, isFinal: boolean) => {
        if (!isFinal) {
          logError('an error occured, attempting to retry');
        }
      },
      this.config.retryTolerance
    );
    requestId = responseData.requestId;

    if (responseData.success === true) {
      const nodeSignatures: Signature[] = (
        responseData as SuccessNodePromises<any>
      ).values.map((r: any) => {
        const sig = ethers.utils.splitSignature(`0x${r.signature}`);
        return {
          r: sig.r,
          s: sig.s,
          v: sig.v,
        };
      });

      logWithRequestId(
        requestId,
        `responseData: ${JSON.stringify(responseData, null, 2)}`
      );

      const derivedKeyId = (responseData as SuccessNodePromises<any>).values[0]
        .derivedKeyId;

      const pubkey: string = this.computeHDPubKey(derivedKeyId);
      logWithRequestId(
        requestId,
        `pubkey ${pubkey} derived from key id ${derivedKeyId}`
      );

      const relayParams: ClaimRequest<'relay'> =
        params as ClaimRequest<'relay'>;

      let mintTx = '';
      if (params.mintCallback && 'signer' in params) {
        mintTx = await params.mintCallback(
          {
            derivedKeyId,
            authMethodType: params.authMethod.authMethodType,
            signatures: nodeSignatures,
            pubkey,
            signer: (params as ClaimRequest<'client'>).signer,
            ...relayParams,
          },
          this.config.litNetwork as LitNetwork
        );
      } else {
        mintTx = await defaultMintClaimCallback(
          {
            derivedKeyId,
            authMethodType: params.authMethod.authMethodType,
            signatures: nodeSignatures,
            pubkey,
            ...relayParams,
          },
          this.config.litNetwork as LitNetwork
        );
      }

      return {
        signatures: nodeSignatures,
        claimedKeyId: derivedKeyId,
        pubkey,
        mintTx,
      };
    } else {
      return throwError({
        message: `Claim request has failed. Request trace id: lit_${requestId} `,
        errorKind: LIT_ERROR.UNKNOWN_ERROR.kind,
        errorCode: LIT_ERROR.UNKNOWN_ERROR.code,
      });
    }
  }

  /**
   *
   * Request a signed JWT from the LIT network. Before calling this function, you must know the access control conditions for the item you wish to gain authorization for.
   *
   * Endpoint: /web/signing/access_control_condition
   *
   * @param { GetSignedTokenRequest } params
   *
   * @returns { Promise<string> } final JWT
   *
   */
  getSignedToken = async (params: GetSignedTokenRequest): Promise<string> => {
    // ========== Prepare Params ==========
    const { chain, authSig, sessionSigs } = params;

    // ========== Validation ==========
    // -- validate if it's ready
    if (!this.ready) {
      const message =
        '3 LitNodeClient is not ready.  Please call await litNodeClient.connect() first.';
      throwError({
        message,
        errorKind: LIT_ERROR.LIT_NODE_CLIENT_NOT_READY_ERROR.kind,
        errorCode: LIT_ERROR.LIT_NODE_CLIENT_NOT_READY_ERROR.name,
      });
    }

    // -- validate if this.networkPubKeySet is null
    if (this.networkPubKeySet === null) {
      return throwError({
        message: 'networkPubKeySet cannot be null',
        errorKind: LIT_ERROR.PARAM_NULL_ERROR.kind,
        errorCode: LIT_ERROR.PARAM_NULL_ERROR.name,
      });
    }

    const paramsIsSafe = safeParams({
      functionName: 'getSignedToken',
      params,
    });

    if (!paramsIsSafe) {
      return throwError({
        message: `Parameter validation failed.`,
        errorKind: LIT_ERROR.INVALID_ARGUMENT_EXCEPTION.kind,
        errorCode: LIT_ERROR.INVALID_ARGUMENT_EXCEPTION.name,
      });
    }

    // ========== Prepare ==========
    // we need to send jwt params iat (issued at) and exp (expiration)
    // because the nodes may have different wall clock times
    // the nodes will verify that these params are withing a grace period
    const { iat, exp } = this.#getJWTParams();

    // ========== Formatting Access Control Conditions =========
    const {
      error,
      formattedAccessControlConditions,
      formattedEVMContractConditions,
      formattedSolRpcConditions,
      formattedUnifiedAccessControlConditions,
    }: FormattedMultipleAccs = this.getFormattedAccessControlConditions(params);

    if (error) {
      return throwError({
        message: `You must provide either accessControlConditions or evmContractConditions or solRpcConditions or unifiedAccessControlConditions`,
        errorKind: LIT_ERROR.INVALID_ARGUMENT_EXCEPTION.kind,
        errorCode: LIT_ERROR.INVALID_ARGUMENT_EXCEPTION.name,
      });
    }

    // ========== Get Node Promises ==========
    const wrapper = async (
      id: string
    ): Promise<SuccessNodePromises<any> | RejectedNodePromises> => {
      const nodePromises = this._getNodePromises((url: string) => {
        // -- if session key is available, use it
        const authSigToSend = sessionSigs ? sessionSigs[url] : authSig;

        const reqBody: SigningAccessControlConditionRequest = {
          accessControlConditions: formattedAccessControlConditions,
          evmContractConditions: formattedEVMContractConditions,
          solRpcConditions: formattedSolRpcConditions,
          unifiedAccessControlConditions:
            formattedUnifiedAccessControlConditions,
          chain,
          authSig: authSigToSend,
          iat,
          exp,
        };

        const urlWithPath = composeLitUrl({
          url,
          endpoint: LIT_ENDPOINT.SIGN_ACCS,
        });

        return this.#generatePromise(urlWithPath, reqBody, id);
      });

      // -- resolve promises
      const res = await this._handleNodePromises(
        nodePromises,
        id,
        this.config.minNodeCount
      );
      return res;
    };

    const res = await executeWithRetry<
      RejectedNodePromises | SuccessNodePromises<any>
    >(
      wrapper,
      (error: any, requestId: string, isFinal: boolean) => {
        if (!isFinal) {
          logError('an error occured, attempting to retry ');
        }
      },
      this.config.retryTolerance
    );
    const requestId = res.requestId;

    // -- case: promises rejected
    if (res.success === false) {
      this._throwNodeError(res as RejectedNodePromises, requestId);
    }

    const signatureShares: NodeBlsSigningShare[] = (
      res as SuccessNodePromises<NodeBlsSigningShare>
    ).values;

    log('signatureShares', signatureShares);

    // ========== Result ==========
    const finalJwt: string = this.#combineSharesAndGetJWT(
      signatureShares,
      requestId
    );

    return finalJwt;
  };

  /**
   *
   * Decrypt ciphertext with the LIT network.
   *
   * Endpoint: /web/encryption/sign
   *
   */
  decrypt = async (params: DecryptRequest): Promise<DecryptResponse> => {
    const { sessionSigs, chain, ciphertext, dataToEncryptHash } = params;

    // ========== Validate Params ==========
    // -- validate if it's ready
    if (!this.ready) {
      const message =
        '6 LitNodeClient is not ready.  Please call await litNodeClient.connect() first.';
      throwError({
        message,
        errorKind: LIT_ERROR.LIT_NODE_CLIENT_NOT_READY_ERROR.kind,
        errorCode: LIT_ERROR.LIT_NODE_CLIENT_NOT_READY_ERROR.name,
      });
    }

    // -- validate if this.subnetPubKey is null
    if (!this.subnetPubKey) {
      const message = 'subnetPubKey cannot be null';
      return throwError({
        message,
        errorKind: LIT_ERROR.LIT_NODE_CLIENT_NOT_READY_ERROR.kind,
        errorCode: LIT_ERROR.LIT_NODE_CLIENT_NOT_READY_ERROR.name,
      });
    }

    const paramsIsSafe = safeParams({
      functionName: 'decrypt',
      params,
    });

    if (!paramsIsSafe) {
      return throwError({
        message: `Parameter validation failed.`,
        errorKind: LIT_ERROR.INVALID_ARGUMENT_EXCEPTION.kind,
        errorCode: LIT_ERROR.INVALID_ARGUMENT_EXCEPTION.name,
      });
    }

    // ========== Hashing Access Control Conditions =========
    // hash the access control conditions
    const hashOfConditions: ArrayBuffer | undefined =
      await this.getHashedAccessControlConditions(params);

    if (!hashOfConditions) {
      return throwError({
        message: `You must provide either accessControlConditions or evmContractConditions or solRpcConditions or unifiedAccessControlConditions`,
        errorKind: LIT_ERROR.INVALID_ARGUMENT_EXCEPTION.kind,
        errorCode: LIT_ERROR.INVALID_ARGUMENT_EXCEPTION.name,
      });
    }

    const hashOfConditionsStr = uint8arrayToString(
      new Uint8Array(hashOfConditions),
      'base16'
    );

    // ========== Formatting Access Control Conditions =========
    const {
      error,
      formattedAccessControlConditions,
      formattedEVMContractConditions,
      formattedSolRpcConditions,
      formattedUnifiedAccessControlConditions,
    }: FormattedMultipleAccs = this.getFormattedAccessControlConditions(params);

    if (error) {
      throwError({
        message: `You must provide either accessControlConditions or evmContractConditions or solRpcConditions or unifiedAccessControlConditions`,
        errorKind: LIT_ERROR.INVALID_ARGUMENT_EXCEPTION.kind,
        errorCode: LIT_ERROR.INVALID_ARGUMENT_EXCEPTION.name,
      });
    }

    // ========== Assemble identity parameter ==========
    const identityParam = this.#getIdentityParamForEncryption(
      hashOfConditionsStr,
      dataToEncryptHash
    );

    log('identityParam', identityParam);

    // ========== Get Network Signature ==========
    const wrapper = async (
      id: string
    ): Promise<SuccessNodePromises<any> | RejectedNodePromises> => {
      const nodePromises = this._getNodePromises((url: string) => {
        // -- if session key is available, use it
        const authSigToSend = sessionSigs ? sessionSigs[url] : params.authSig;

        if (!authSigToSend) {
          return throwError({
            message: `authSig is required`,
            errorKind: LIT_ERROR.INVALID_ARGUMENT_EXCEPTION.kind,
            errorCode: LIT_ERROR.INVALID_ARGUMENT_EXCEPTION.name,
          });
        }

        const reqBody: EncryptionSignRequest = {
          accessControlConditions: formattedAccessControlConditions,
          evmContractConditions: formattedEVMContractConditions,
          solRpcConditions: formattedSolRpcConditions,
          unifiedAccessControlConditions:
            formattedUnifiedAccessControlConditions,
          dataToEncryptHash,
          chain,
          authSig: authSigToSend,
          epoch: this.currentEpochNumber!,
        };

        const urlWithParh = composeLitUrl({
          url,
          endpoint: LIT_ENDPOINT.ENCRYPTION_SIGN,
        });

        return this.#generatePromise(urlWithParh, reqBody, id);
      });

      // -- resolve promises
      const res = await this._handleNodePromises(
        nodePromises,
        id,
        this.config.minNodeCount
      );
      return res;
    };

    const res = await executeWithRetry<
      RejectedNodePromises | SuccessNodePromises<any>
    >(
      wrapper,
      (_error: string, _requestId: string, _isFinal: boolean) => {
        logError('an error occured attempting to retry');
      },
      this.config.retryTolerance
    );

    const requestId = res.requestId;

    // -- case: promises rejected
    if (res.success === false) {
      this._throwNodeError(res as RejectedNodePromises, requestId);
    }

    const signatureShares: NodeBlsSigningShare[] = (
      res as SuccessNodePromises<NodeBlsSigningShare>
    ).values;

    logWithRequestId(requestId, 'signatureShares', signatureShares);

    // ========== Result ==========
    const decryptedData = this.#decryptWithSignatureShares(
      this.subnetPubKey,
      uint8arrayFromString(identityParam, 'utf8'),
      ciphertext,
      signatureShares
    );

    return { decryptedData };
  };
}
