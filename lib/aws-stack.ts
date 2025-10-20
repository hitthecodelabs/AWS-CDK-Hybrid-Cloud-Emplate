// lib/jordan-aws-stack.ts

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as dotenv from 'dotenv';

// Carga variables de entorno desde .env (si existe)
dotenv.config();

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return v;
}

function envBool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'y'].includes(v.toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return n;
}

// Mapea "t3.medium" → InstanceType
function parseInstanceType(raw: string): ec2.InstanceType {
  try {
    const [family, size] = raw.split('.');
    return ec2.InstanceType.of(
      ec2.InstanceClass[family.toUpperCase() as keyof typeof ec2.InstanceClass],
      ec2.InstanceSize[size.toUpperCase() as keyof typeof ec2.InstanceSize]
    );
  } catch {
    // fallback seguro
    return ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM);
  }
}

/**
 * ============================================================
 *  JordanAwsStack — Plantilla reproducible (sin secretos)
 *  - Requiere .env con las variables descritas arriba
 *  - Útil para escenarios híbridos (VPN S2S + EC2 + RDS)
 * ============================================================
 */
export class JordanAwsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -------------------------------
    // 0) Parámetros desde .env
    // -------------------------------
    const NAT_GATEWAYS = envInt('NAT_GATEWAYS', 1);
    const INSTANCE_TYPE = parseInstanceType(process.env.EC2_INSTANCE_TYPE ?? 't3.medium');

    const SSH_ALLOWED_IP = env('SSH_ALLOWED_IP'); // p.ej. "190.63.237.122/32"
    const EC2_KEY_PAIR_NAME = env('EC2_KEY_PAIR_NAME'); // nombre de key pair existente

    // Egress opcional hacia SAP (si no quieres, deja SAP_API_HOST_IP vacío y se omite la regla)
    const SAP_API_HOST_IP = process.env.SAP_API_HOST_IP; // p.ej. "10.1.0.15/32"
    const SAP_API_PORT = parseInt(process.env.SAP_API_PORT ?? '50000', 10);

    // VPN S2S
    const CGW_PUBLIC_IP = env('CGW_PUBLIC_IP'); // IP pública del firewall on-prem (Sophos/Azure, etc.)
    const CGW_BGP_ASN = parseInt(process.env.CGW_BGP_ASN ?? '65000', 10);
    const VPN_PSK = env('VPN_PRESHARED_KEY'); // PSK de ambos túneles
    const REMOTE_NETWORK_CIDR = env('REMOTE_NETWORK_CIDR'); // p.ej. "10.1.0.0/16"

    // Base de datos
    const ENABLE_RDS = envBool('ENABLE_RDS', true);
    const DB_NAME = process.env.DB_NAME ?? 'appdb';
    const DB_ADMIN_USER = process.env.DB_ADMIN_USER ?? 'dbadmin';
    const DB_RETAIN = envBool('DB_RETAIN', false); // true para producción

    // -------------------------------
    // 1) Red (VPC) con VGW para VPN
    // -------------------------------
    const vpc = new ec2.Vpc(this, 'HybridCloudVPC', {
      maxAzs: 2,
      natGateways: NAT_GATEWAYS,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
      vpnGateway: true, // Crea el Virtual Private Gateway (VGW)
    });

    // Propagación de rutas de la VPN en tablas de ruteo (públicas y privadas)
    (vpc.publicSubnets as ec2.Subnet[]).forEach((subnet, idx) => {
      new ec2.CfnVPNGatewayRoutePropagation(this, `VpnPropPublic${idx}`, {
        routeTableIds: [subnet.routeTable.routeTableId],
        vpnGatewayId: vpc.vpnGatewayId!,
      });
    });
    (vpc.privateSubnets as ec2.Subnet[]).forEach((subnet, idx) => {
      new ec2.CfnVPNGatewayRoutePropagation(this, `VpnPropPrivate${idx}`, {
        routeTableIds: [subnet.routeTable.routeTableId],
        vpnGatewayId: vpc.vpnGatewayId!,
      });
    });

    // -------------------------------
    // 2) Seguridad del servidor web
    // -------------------------------
    const webSG = new ec2.SecurityGroup(this, 'WebServerSG', {
      vpc,
      description: 'Permite tráfico HTTP/HTTPS, SSH controlado y egress explícito',
      allowAllOutbound: false, // reglas de salida explícitas
    });

    // Ingress HTTP (80) desde Internet
    webSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP público');

    // Ingress SSH (22) restringido a tu IP
    webSG.addIngressRule(ec2.Peer.ipv4(SSH_ALLOWED_IP), ec2.Port.tcp(22), 'SSH desde IP permitida');

    // Egress ICMP (ping) para diagnóstico
    webSG.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.allIcmp(), 'ICMP saliente (ping)');

    // Egress web para updates
    webSG.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS saliente');
    webSG.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP saliente');

    // Egress opcional hacia SAP si se definió host
    if (SAP_API_HOST_IP && SAP_API_HOST_IP.trim() !== '') {
      webSG.addEgressRule(ec2.Peer.ipv4(SAP_API_HOST_IP), ec2.Port.tcp(SAP_API_PORT), 'Salida a SAP/API');
    }

    // -------------------------------
    // 3) EC2 + EIP (pública estática)
    // -------------------------------
    const webServer = new ec2.Instance(this, 'WebServer', {
      vpc,
      instanceType: INSTANCE_TYPE,
      machineImage: ec2.MachineImage.latestAmazonLinux2(), // puedes cambiar a Amazon Linux 2023 si prefieres
      securityGroup: webSG,
      // Nota: keyName está deprecated en CDK v2; si usas KeyPair L2, ajusta aquí según tu versión de CDK.
      keyName: EC2_KEY_PAIR_NAME,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      associatePublicIpAddress: false, // usaremos EIP
      requireImdsv2: true,
    });

    const eip = new ec2.CfnEIP(this, 'WebServerEip');
    new ec2.CfnEIPAssociation(this, 'WebServerEipAssociation', {
      eip: eip.ref,
      instanceId: webServer.instanceId,
    });

    // -------------------------------
    // 4) VPN Site-to-Site (CGW + VPN + ruta)
    // -------------------------------
    const cgw = new ec2.CfnCustomerGateway(this, 'CustomerGateway', {
      type: 'ipsec.1',
      ipAddress: CGW_PUBLIC_IP,
      bgpAsn: CGW_BGP_ASN,
    });

    const vpn = new ec2.CfnVPNConnection(this, 'SiteToSiteVpn', {
      customerGatewayId: cgw.ref,
      type: 'ipsec.1',
      vpnGatewayId: vpc.vpnGatewayId!,
      staticRoutesOnly: true, // estática (si usas BGP dinámico, cambia a false y añade routes BGP)
      vpnTunnelOptionsSpecifications: [
        {
          preSharedKey: VPN_PSK,
          ikeVersions: [{ value: 'ikev2' }],
          phase1EncryptionAlgorithms: [{ value: 'AES256' }],
          phase1IntegrityAlgorithms: [{ value: 'SHA2-256' }],
          phase1DhGroupNumbers: [{ value: 14 }],
          phase1LifetimeSeconds: 28800,
          phase2EncryptionAlgorithms: [{ value: 'AES256' }],
          phase2IntegrityAlgorithms: [{ value: 'SHA2-256' }],
          phase2DhGroupNumbers: [{ value: 14 }],
          phase2LifetimeSeconds: 3600,
        },
        {
          preSharedKey: VPN_PSK,
          ikeVersions: [{ value: 'ikev2' }],
          phase1EncryptionAlgorithms: [{ value: 'AES256' }],
          phase1IntegrityAlgorithms: [{ value: 'SHA2-256' }],
          phase1DhGroupNumbers: [{ value: 14 }],
          phase1LifetimeSeconds: 28800,
          phase2EncryptionAlgorithms: [{ value: 'AES256' }],
          phase2IntegrityAlgorithms: [{ value: 'SHA2-256' }],
          phase2DhGroupNumbers: [{ value: 14 }],
          phase2LifetimeSeconds: 3600,
        },
      ],
    });

    new ec2.CfnVPNConnectionRoute(this, 'VpnStaticRoute', {
      destinationCidrBlock: REMOTE_NETWORK_CIDR,
      vpnConnectionId: vpn.ref,
    });

    // -------------------------------
    // 5) Seguridad y RDS (opcional)
    // -------------------------------
    let dbEndpoint = '';
    let dbSecretName = '';

    if (ENABLE_RDS) {
      const dbSG = new ec2.SecurityGroup(this, 'DbSG', {
        vpc,
        description: 'Acceso a MariaDB solo desde WebServer',
      });
      dbSG.addIngressRule(webSG, ec2.Port.tcp(3306), 'MariaDB desde WebServer');

      const db = new rds.DatabaseInstance(this, 'MariaDB', {
        engine: rds.DatabaseInstanceEngine.mariaDb({
          version: rds.MariaDbEngineVersion.VER_10_6,
        }),
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [dbSG],
        databaseName: DB_NAME,
        credentials: rds.Credentials.fromGeneratedSecret(DB_ADMIN_USER),
        allocatedStorage: 20,
        removalPolicy: DB_RETAIN ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        deleteAutomatedBackups: !DB_RETAIN,
        backupRetention: cdk.Duration.days(DB_RETAIN ? 7 : 0),
      });

      dbEndpoint = db.dbInstanceEndpointAddress;
      dbSecretName = db.secret?.secretName ?? '';
    }

    // -------------------------------
    // 6) Salidas (Outputs)
    // -------------------------------
    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'ID de la VPC',
    });

    new cdk.CfnOutput(this, 'PublicElasticIp', {
      value: eip.ref,
      description: 'IP pública (EIP) del WebServer',
    });

    new cdk.CfnOutput(this, 'WebServerInstanceId', {
      value: webServer.instanceId,
      description: 'ID de la instancia EC2',
    });

    new cdk.CfnOutput(this, 'WebServerSecurityGroupId', {
      value: webSG.securityGroupId,
      description: 'ID del SG del WebServer',
    });

    new cdk.CfnOutput(this, 'CustomerGatewayId', {
      value: cgw.ref,
      description: 'ID del Customer Gateway',
    });

    new cdk.CfnOutput(this, 'VpnConnectionId', {
      value: vpn.ref,
      description: 'ID de la conexión VPN',
    });

    if (ENABLE_RDS) {
      new cdk.CfnOutput(this, 'DBEndpointAddress', {
        value: dbEndpoint,
        description: 'Endpoint de la Base de Datos RDS',
      });
      new cdk.CfnOutput(this, 'DBSecretName', {
        value: dbSecretName || 'No Secret Name',
        description: 'Nombre del secreto (credenciales) en Secrets Manager',
      });
    }

    // Tags útiles
    cdk.Tags.of(this).add('Project', 'Hybrid-Cloud-Template');
    cdk.Tags.of(this).add('Owner', 'JordanAwsStack');
    cdk.Tags.of(this).add('Environment', this.node.tryGetContext('env') ?? 'dev');
  }
}
