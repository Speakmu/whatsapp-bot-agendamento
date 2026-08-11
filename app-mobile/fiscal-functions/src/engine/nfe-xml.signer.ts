import { Injectable, Logger } from '@nestjs/common';
import * as forge from 'node-forge';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SignedXml } = require('xml-crypto') as typeof import('xml-crypto');

export interface CertificateData {
  privateKeyPem: string;
  certificatePem: string;
  /** X.509 certificate in DER → Base64 (used inside <X509Certificate>) */
  certBase64: string;
}

export interface NfeSignResult {
  /** Signed XML with <Signature> block as child of <NFe>, after <infNFeSupl> when present */
  signedXml: string;
  /** Access key (44 digits with check digit) extracted from Id */
  chave44: string;
}

@Injectable()
export class NfeXmlSigner {
  private readonly logger = new Logger(NfeXmlSigner.name);

  // ── Certificate loading ──────────────────────────────────────────────────

  /**
   * Loads a PFX certificate from file path + password.
   * The PFX file path is resolved relative to backend root or as absolute path.
   */
  loadCertificateFromFile(pfxPath: string, password: string): CertificateData {
    const resolvedPath = path.isAbsolute(pfxPath)
      ? pfxPath
      : path.resolve(process.cwd(), pfxPath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Certificado não encontrado: ${resolvedPath}`);
    }

    const pfxBuffer = fs.readFileSync(resolvedPath);
    return this.parsePfx(pfxBuffer, password);
  }

  /**
   * Loads a PFX certificate from a Buffer (e.g. stored in DB or env var as base64).
   */
  loadCertificateFromBuffer(pfxBuffer: Buffer, password: string): CertificateData {
    return this.parsePfx(pfxBuffer, password);
  }

  private parsePfx(pfxBuffer: Buffer, password: string): CertificateData {
    const pfxB64 = pfxBuffer.toString('binary');
    const pfxAsn1 = forge.asn1.fromDer(pfxB64);
    const pfx = forge.pkcs12.pkcs12FromAsn1(pfxAsn1, password);

    // Extract private key
    const keyBags = pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
    const pkcs8Bags = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [];
    if (pkcs8Bags.length === 0) {
      // Try keyBag
      const keyBags2 = pfx.getBags({ bagType: forge.pki.oids.keyBag });
      const kb = keyBags2[forge.pki.oids.keyBag] ?? [];
      if (kb.length === 0) throw new Error('Chave privada não encontrada no certificado PFX');
    }

    let privateKey: forge.pki.rsa.PrivateKey;
    const shroudedBags = pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
    const shroudedList = shroudedBags[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [];
    if (shroudedList.length > 0 && shroudedList[0].key) {
      privateKey = shroudedList[0].key as forge.pki.rsa.PrivateKey;
    } else {
      const plainBags = pfx.getBags({ bagType: forge.pki.oids.keyBag });
      const plainList = plainBags[forge.pki.oids.keyBag] ?? [];
      if (plainList.length === 0 || !plainList[0].key) {
        throw new Error('Não foi possível extrair a chave privada do certificado');
      }
      privateKey = plainList[0].key as forge.pki.rsa.PrivateKey;
    }

    // Extract certificate
    const certBags = pfx.getBags({ bagType: forge.pki.oids.certBag });
    const certList = certBags[forge.pki.oids.certBag] ?? [];
    if (certList.length === 0 || !certList[0].cert) {
      throw new Error('Certificado X.509 não encontrado no PFX');
    }
    const cert = certList[0].cert!;

    const privateKeyPem = forge.pki.privateKeyToPem(privateKey);
    const certificatePem = forge.pki.certificateToPem(cert);

    // DER in base64 for <X509Certificate>
    const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    const certBase64 = Buffer.from(certDer, 'binary').toString('base64');

    return { privateKeyPem, certificatePem, certBase64 };
  }

  // ── XML Signing (XMLDSig + C14N Exclusive) ───────────────────────────────

  /**
   * Signs the NF-e XML according to SEFAZ specifications:
   *   - Reference URI = "#NFe{chave44}"
   *   - Transforms: enveloped-signature + c14n-exclusive
    *   - DigestMethod: SHA-1
    *   - SignatureMethod: RSA-SHA1
   *
  * The <Signature> block must be a direct child of <NFe>, placed after </infNFeSupl>
  * when NFC-e supplemental data exists, otherwise after </infNFe>.
   */
  sign(unsignedXml: string, cert: CertificateData): NfeSignResult {
    // Extract chave44 from Id attribute
    const idMatch = unsignedXml.match(/Id="NFe(\d{44})"/);
    if (!idMatch) {
      throw new Error('Id da NF-e não encontrado no XML. Formato esperado: Id="NFe{44 dígitos}"');
    }
    const chave44 = idMatch[1];
    const refUri = `NFe${chave44}`;

    const signer = new SignedXml();
    signer.privateKey = cert.privateKeyPem;
    signer.publicCert = cert.certificatePem;
    signer.signatureAlgorithm =
      'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
    signer.canonicalizationAlgorithm = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
    signer.addReference({
      xpath: "//*[local-name()='infNFe']",
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
      ],
      digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
      uri: `#${refUri}`,
    });

    signer.computeSignature(unsignedXml, {
      location: {
        reference: "//*[local-name()='infNFe']",
        action: 'after',
      },
    });

    const signedXml = this.normalizeSignedNfeOrder(signer.getSignedXml());

    this.logger.debug(`NF-e assinada: chave ${chave44}`);
    return { signedXml, chave44 };
  }

  /**
   * Signs the <evento> XML for SEFAZ events (cancellation, CCES, etc.).
   * Uses xml-crypto to build the XMLDSig block in the exact structure expected by SEFAZ.
   * Per the NF-e event schema, <Signature> is a direct child of <evento>,
   * placed AFTER </infEvento> — NOT inside <infEvento>.
   */
  signEvento(eventoXml: string, cert: CertificateData): string {
    const idMatch = eventoXml.match(/Id="(ID[^"]+)"/);
    if (!idMatch) {
      throw new Error('Id da infEvento não encontrado no XML de evento');
    }
    const refId = idMatch[1];

    const signer = new SignedXml();
    signer.privateKey = cert.privateKeyPem;
    signer.publicCert = cert.certificatePem;
    signer.signatureAlgorithm =
      'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
    signer.canonicalizationAlgorithm = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
    signer.addReference({
      xpath: "//*[local-name()='infEvento']",
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
      ],
      digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
      uri: `#${refId}`,
    });

    signer.computeSignature(eventoXml, {
      location: {
        reference: "//*[local-name()='infEvento']",
        action: 'after',
      },
    });

    this.logger.debug(`Evento assinado: ref ${refId}`);
    return signer.getSignedXml();
  }

  /**
   * Signs the <inutNFe> XML for SEFAZ inutilização (NFeInutilizacao4).
   * Per the schema, <Signature> is a sibling of <infInut>, inside <inutNFe>,
   * placed immediately AFTER </infInut>.
   */
  signInutilizacao(inutNFeXml: string, cert: CertificateData): string {
    const idMatch = inutNFeXml.match(/Id="(ID[^"]+)"/);
    if (!idMatch) {
      throw new Error('Id da infInut não encontrado no XML de inutilização');
    }
    const refId = idMatch[1];

    const signer = new SignedXml();
    signer.privateKey = cert.privateKeyPem;
    signer.publicCert = cert.certificatePem;
    signer.signatureAlgorithm =
      'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
    signer.canonicalizationAlgorithm = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
    signer.addReference({
      xpath: "//*[local-name()='infInut']",
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
      ],
      digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
      uri: `#${refId}`,
    });

    signer.computeSignature(inutNFeXml, {
      location: {
        reference: "//*[local-name()='infInut']",
        action: 'after',
      },
    });

    this.logger.debug(`Inutilizacao assinada: ref ${refId}`);
    return signer.getSignedXml();
  }

  // ── private helpers ───────────────────────────────────────────────────────

  private normalizeSignedNfeOrder(signedXml: string): string {
    const infNFeSuplMatch = signedXml.match(/<infNFeSupl\b[\s\S]*?<\/infNFeSupl>/);
    const signatureMatch = signedXml.match(/<Signature\b[\s\S]*?<\/Signature>/);

    if (!infNFeSuplMatch || !signatureMatch) {
      return signedXml;
    }

    const infNFeSuplXml = infNFeSuplMatch[0];
    const signatureXml = signatureMatch[0];
    const infNFeSuplIndex = signedXml.indexOf(infNFeSuplXml);
    const signatureIndex = signedXml.indexOf(signatureXml);

    if (infNFeSuplIndex < signatureIndex) {
      return signedXml;
    }

    return signedXml
      .replace(infNFeSuplXml, '')
      .replace(signatureXml, `${infNFeSuplXml}${signatureXml}`);
  }
}
