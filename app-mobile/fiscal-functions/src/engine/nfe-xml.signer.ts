import { Injectable, Logger } from '@nestjs/common';
import * as forge from 'node-forge';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SignedXml } = require('xml-crypto') as typeof import('xml-crypto');

export interface CertificateData {
  privateKeyPem: string;
  /**
   * Cadeia completa (folha + intermediárias) — usar SÓ para o https.Agent do
   * mTLS com a SEFAZ. NÃO usar para assinar XML: a assinatura XMLDSig espera
   * exatamente um certificado dentro de <X509Certificate>; passar a cadeia
   * inteira aqui quebra o schema da NF-e (rejeição "Falha no schema XML").
   */
  certificatePem: string;
  /** Certificado-folha isolado (1 único PEM) — usar para assinar o XML (KeyInfo/X509Certificate). */
  certificatePemLeaf: string;
  /** X.509 certificate in DER → Base64 (used inside <X509Certificate>) */
  certBase64: string;
  /** Validade do certificado-folha (não a da cadeia inteira) */
  validity: { notBefore: Date; notAfter: Date };
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

    // Extract certificate(s) — um .pfx de certificado A1 da ICP-Brasil normalmente
    // traz o certificado-folha JUNTO com a(s) CA(s) intermediária(s) que o emitiram.
    // Pegar só o primeiro certBag descarta as intermediárias: a SEFAZ (mTLS) então
    // não consegue montar a cadeia até a raiz confiável e derruba a conexão com um
    // "handshake_failure" genérico, sem apontar o certificado como causa. Por isso
    // aqui montamos a cadeia completa (folha + intermediárias, sem a raiz) e mandamos
    // tudo junto no <cert> do https.Agent.
    const certBags = pfx.getBags({ bagType: forge.pki.oids.certBag });
    const certList = certBags[forge.pki.oids.certBag] ?? [];
    if (certList.length === 0 || !certList[0].cert) {
      throw new Error('Certificado X.509 não encontrado no PFX');
    }
    const allCerts = certList.map(b => b.cert).filter((c): c is forge.pki.Certificate => !!c);

    const dn = (attrs: forge.pki.CertificateField[]) =>
      attrs.map(a => `${a.shortName || a.name || a.type}=${a.value}`).join(',');

    // Identifica o certificado-folha comparando o modulo da chave publica com o da privada.
    const privModulus = privateKey.n.toString(16);
    const leafCert = allCerts.find(c => {
      const pub = c.publicKey as forge.pki.rsa.PublicKey;
      return pub?.n && pub.n.toString(16) === privModulus;
    }) ?? allCerts[0];

    // Monta a cadeia folha -> intermediarias seguindo issuer/subject, parando antes
    // de incluir uma raiz autoassinada (subject === issuer).
    const chain: forge.pki.Certificate[] = [leafCert];
    const usados = new Set<forge.pki.Certificate>([leafCert]);
    let atual = leafCert;
    for (let i = 0; i < allCerts.length; i++) {
      const issuerDn = dn(atual.issuer.attributes);
      const proximo = allCerts.find(c => !usados.has(c) && dn(c.subject.attributes) === issuerDn);
      if (!proximo) break;
      const autoAssinado = dn(proximo.subject.attributes) === dn(proximo.issuer.attributes);
      if (autoAssinado) break; // raiz — nao precisa mandar pro servidor
      chain.push(proximo);
      usados.add(proximo);
      atual = proximo;
    }

    const cert = leafCert;
    const privateKeyPem = forge.pki.privateKeyToPem(privateKey);
    const certificatePem = chain.map(c => forge.pki.certificateToPem(c)).join('\n');
    const certificatePemLeaf = forge.pki.certificateToPem(cert);

    // DER in base64 for <X509Certificate> — sempre o certificado-folha (assinatura da NF-e).
    const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    const certBase64 = Buffer.from(certDer, 'binary').toString('base64');

    return {
      privateKeyPem,
      certificatePem,
      certificatePemLeaf,
      certBase64,
      validity: { notBefore: cert.validity.notBefore, notAfter: cert.validity.notAfter },
    };
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
    signer.publicCert = cert.certificatePemLeaf;
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
    signer.publicCert = cert.certificatePemLeaf;
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
    signer.publicCert = cert.certificatePemLeaf;
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
