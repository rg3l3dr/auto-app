import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { ApiPromise, WsProvider } from '@polkadot/api';
import axios from 'axios';
import FormData from 'form-data';
import { RPCClient } from './rpc';
const crypto = pkijs.getCrypto(true);

/**
 *  
 * Write native modules to use TLS with WSS
 * Save and trust certificates into trust store
 * Add a call to the registrar service to register the certificate
 * Support multiple agent connections
 * 
 */

class Controller {
    id: string;
    name: pkijs.AttributeTypeAndValue;
    publicKey: CryptoKeyPair['publicKey'];
    privateKey: CryptoKeyPair['privateKey'];
    certificate: pkijs.Certificate | null = null;
    nextSerialNumber: number = 0;
    registry: ApiPromise;
    rpc: RPCClient;

    constructor(
        id: string, 
        name: pkijs.AttributeTypeAndValue, 
        keys: CryptoKeyPair, 
        registry: ApiPromise,
        rpc: RPCClient,
    ) {
        this.id = id;
        this.name = name;
        this.publicKey = keys.publicKey;
        this.privateKey = keys.privateKey;
        this.registry = registry;
        this.rpc = rpc;
    }

    async createController(id: string): Promise<Controller> {
        const name = this.createName(id);
        const keys = await this.createKeys();
        const registry = await this.createRegistryConnection();
        const rpc = new RPCClient('wss://localhost:8000');
        return new Controller(id, name, keys, registry, rpc);
    }

    createName(id: string): pkijs.AttributeTypeAndValue {
        return new pkijs.AttributeTypeAndValue({
            type: "2.5.4.3", // Common name
            value: new asn1js.BmpString({ value: this.id })
          });
    }

    async createRegistryConnection(): Promise<ApiPromise>{
        const wsProvider = new WsProvider('ws://127.0.0.1:9944');
        const registry = await ApiPromise.create({ provider: wsProvider });
        return registry;
    }

    async createKeys(): Promise<CryptoKeyPair> {
        return await crypto.generateKey("Ed25519", true, ["sign", "verify"]);
    }

    async signMessage(message: Uint8Array): Promise<ArrayBuffer> {
        return await crypto.sign("Ed25519", this.privateKey, message);
    }

    async verifySignature(signature: ArrayBuffer, message: Uint8Array, publicKey: CryptoKeyPair['publicKey']): Promise<boolean> {
        return await crypto.verify("Ed25519", publicKey, signature, message);
    }

    async createCertificate(): Promise<pkijs.Certificate> {
        const certificate = new pkijs.Certificate();
        certificate.version = 2;
        certificate.serialNumber = new asn1js.Integer({ value: this.nextSerialNumber });
        this.nextSerialNumber++;
        certificate.issuer.typesAndValues.push(this.name);
        certificate.subject.typesAndValues.push(this.name);
        certificate.notBefore.value = new Date();
        const notAfter = new Date();
        notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 1);
        certificate.notAfter.value = notAfter;

        // Exporting public key into "subjectPublicKeyInfo" value of certificate
        await certificate.subjectPublicKeyInfo.importKey(this.publicKey);

        // Signing final certificate
        await certificate.sign(this.privateKey, "SHA-256");

        this.certificate = certificate;

        return certificate;
    }

    async signCSR(csr: pkijs.CertificationRequest): Promise<pkijs.Certificate> {
        const verified = await csr.verify();
        if (!verified) {
            throw new Error("CSR signature verification failed.");
        }

        const certificate = new pkijs.Certificate();
        certificate.subject = csr.subject;        
        certificate.subjectPublicKeyInfo = csr.subjectPublicKeyInfo;
        certificate.issuer.typesAndValues.push(this.name);
        certificate.notBefore.value = new Date();
        certificate.notAfter.value = new Date(new Date().setFullYear(new Date().getFullYear() + 1));
        certificate.serialNumber = new asn1js.Integer({ value: this.nextSerialNumber });
        this.nextSerialNumber++;
        await certificate.sign(this.privateKey, "SHA-256");
        return certificate;
    }

    async validateCertificate(certificate: pkijs.Certificate): Promise<boolean> {
        const verified = await certificate.verify();
        // TODO: implement full verification
        return verified;
    }

    async ValidateCertificateIsRegistered(certificate: pkijs.Certificate): Promise<boolean> {
        const identifier: string = certificate.subject.typesAndValues[0].value.valueBlock.value;
        const publicKey: ArrayBuffer = certificate.subjectPublicKeyInfo.subjectPublicKey.valueBlock.toBER(false);
        const publicKeyBytes: Uint8Array = new Uint8Array(publicKey);
        const codec = await this.registry.query.storage.get('registry', identifier, publicKeyBytes);
        // TODO parse the codec and check if the certificate is registered
        return new Promise((resolve, reject) => { true });
    }

    async longPollForAgentCSR(): Promise<string> {
        const getUrl = 'http://localhost:8000/get_unsigned_csr';
    
        const poll = async (resolve: (value: string | PromiseLike<string>) => void) => {
            try {
                const response = await axios.get(getUrl);
                if (response.status === 200 && response.data.unsigned_csr) {
                    console.log(`Received unsigned CSR: ${response.data.unsigned_csr}`);
                    resolve(response.data.unsigned_csr);
                } else {
                    setTimeout(() => poll(resolve), 1000); // Wait 1 second before polling again
                }
            } catch (error) {
                console.error('Error polling for CSR:', error);
                setTimeout(() => poll(resolve), 1000); // Wait 1 second before retrying
            }
        };
    
        return new Promise(poll);
    }

    async postSignedCertToAgent(certificatePem: string): Promise<void> {
        const postUrl = 'http://localhost:8000/put_signed_csr';
        let formData = new FormData();
        formData.append('cert_file', {
            // React Native might require a different approach for creating a blob or file-like object
            // This is a conceptual example; the actual implementation might vary
            uri: certificatePem,
            type: 'application/x-pem-file',
            name: 'cert_file.pem',
        });
    
        try {
            const response = await axios.post(postUrl, formData, {
                headers: formData.getHeaders ? formData.getHeaders() : {
                    'Content-Type': 'multipart/form-data',
                },
            });
            if (response.status === 200) {
                console.log(response.data.message);
            } else {
                console.log('Failed to post signed certificate:', response.status, response.statusText);
            }
        } catch (error) {
            console.error('Error posting signed certificate:', error);
        }
    }

    
    async invite_agent(hostID: string, hostURI: string) {
        const invite = await this.rpc.send('invite_agent', [hostID, hostURI]);
    
        // Use optional chaining to safely access 'result' and 'error', and nullish coalescing for fallback values
        const result = invite?.result ?? 'No response received';
        const error = invite?.error?.message ?? 'No error information';
    
        if (invite?.result) {
            console.log('Agent invited:', result);
        } else {
            // Log the error message or a fallback message
            console.log('Failed to invite agent:', error);
        }
    }
}


