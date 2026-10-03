/**
 * Bluetooth Service
 * Handles connection to ESP32 via Web Bluetooth API.
 * 
 * Note: Standard BLE Heart Rate Service UUID is 0x180D
 * Standard Heart Rate Measurement Characteristic UUID is 0x2A37
 * 
 * For this thesis prototype, we assume the ESP32 advertises a custom service
 * or standard services that bundle HR, SpO2, and Temp.
 */

// Define Web Bluetooth interfaces to satisfy TypeScript as they might be missing in standard libs
interface BluetoothDevice extends EventTarget {
  id: string;
  name?: string;
  gatt?: BluetoothRemoteGATTServer;
}

interface BluetoothRemoteGATTServer {
  device: BluetoothDevice;
  connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
}

interface Bluetooth {
  requestDevice(options?: RequestDeviceOptions): Promise<BluetoothDevice>;
}

interface RequestDeviceOptions {
  filters?: BluetoothLEScanFilter[];
  optionalServices?: (string | number)[];
  acceptAllDevices?: boolean;
}

interface BluetoothLEScanFilter {
  name?: string;
  namePrefix?: string;
  services?: (string | number)[];
  manufacturerData?: { companyIdentifier: number; dataPrefix?: BufferSource; mask?: BufferSource }[];
  serviceData?: { service: string | number; dataPrefix?: BufferSource; mask?: BufferSource }[];
}

// Augment the global Navigator interface
declare global {
  interface Navigator {
    bluetooth: Bluetooth;
  }
}

export type IoTQuality = 'measuring' | 'stable' | 'poor_signal';

export interface IoTData {
  heartRate: number;
  spo2: number;
  temperature: number;
  finger?: boolean;
  // true solo después de CAPTURA_LISTA: SpO2, FC y temperatura estables a la vez
  ready: boolean;
  quality: IoTQuality;
}

// Evento de la característica de diagnóstico ("ensayo,código,tiempo_ms")
export interface IoTDiagEvent {
  trial: number;
  code: string;
  event: string;        // Nombre del evento en el CSV del firmware
  elapsedMs: number;    // ms desde CONTACTO medidos por el ESP32
  receivedAt: number;   // Date.now() al recibir la notificación
}

export const ESP32_BLE_CONFIG = {
  SERVICE_UUID: '4fafc201-1fb5-459e-8fcc-c5c9c331914b',
  CHARACTERISTIC_UUID: 'beb5483e-36e1-4688-b7f5-ea07361b26a8',
  DIAG_CHARACTERISTIC_UUID: '9c1e7a42-5d3b-4f86-a0e2-7b4d1c6f8e35',
  DEVICE_NAME: 'MediChain_IoT'
};

// Códigos cortos del firmware → nombre del evento en el CSV (ENSAYO,EVENTO,TIEMPO_MS)
export const DIAG_EVENT_NAMES: Record<string, string> = {
  C: 'CONTACTO',
  S1: 'SPO2_PRIMER_CALCULO',
  F1: 'FC_PRIMER_VALOR',
  S: 'SPO2_ESTABLE',
  F: 'FC_ESTABLE',
  T: 'TEMP_ESTABLE',
  L: 'CAPTURA_LISTA',
  INC: 'INCOMPLETO',
  TO: 'TIMEOUT',
  R: 'RETIRO'
};

const parseIoTData = (jsonStr: string): IoTData => {
  const p = JSON.parse(jsonStr);
  const quality: IoTQuality =
    p.quality === 'stable' || p.quality === 'poor_signal' ? p.quality : 'measuring';
  return {
    heartRate: Number(p.hr) || 0,
    spo2: Number(p.spo2) || 0,
    temperature: Number(p.temp) || 0,
    finger: p.finger === true || p.finger === 'true',
    ready: p.ready === true || p.ready === 'true',
    quality
  };
};

const parseDiagEvent = (text: string): IoTDiagEvent | null => {
  const [trial, code, elapsed] = text.trim().split(',');
  const trialNum = Number(trial);
  const elapsedMs = Number(elapsed);
  // "0,-,0" es el valor inicial, antes del primer ensayo
  if (!code || !(code in DIAG_EVENT_NAMES) || !Number.isFinite(trialNum) || !Number.isFinite(elapsedMs)) {
    return null;
  }
  return { trial: trialNum, code, event: DIAG_EVENT_NAMES[code], elapsedMs, receivedAt: Date.now() };
};

export class BluetoothDeviceController {
  private device: any | null = null;
  private server: any | null = null;
  private characteristic: any | null = null;
  private diagCharacteristic: any | null = null;
  private onDataCallback: ((data: IoTData) => void) | null = null;
  private onDiagCallback: ((event: IoTDiagEvent) => void) | null = null;
  // Solo se invoca ante desconexiones NO solicitadas (ESP32 apagado, fuera de rango).
  private onDisconnectCallback: (() => void) | null = null;

  async requestDevice(): Promise<boolean> {
    try {
      if (!('bluetooth' in navigator)) {
        console.warn('Web Bluetooth API no está soportado en este navegador.');
        return false;
      }

      this.device = await (navigator as any).bluetooth.requestDevice({
        filters: [
          { name: ESP32_BLE_CONFIG.DEVICE_NAME },
          { namePrefix: 'MediChain' }
        ],
        optionalServices: [ESP32_BLE_CONFIG.SERVICE_UUID]
      }).catch(async () => {
        // Fallback: mostrar lista general si el filtro por nombre no lo toma
        return await (navigator as any).bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: [ESP32_BLE_CONFIG.SERVICE_UUID]
        });
      });

      if (this.device) {
        this.device.addEventListener('gattserverdisconnected', this.onDisconnected);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Bluetooth Request Error:', error);
      return false;
    }
  }

  async connect(
    onStreamData?: (data: IoTData) => void,
    onDisconnect?: () => void,
    onDiagEvent?: (event: IoTDiagEvent) => void
  ): Promise<IoTData | null> {
    if (!this.device) return null;
    this.onDataCallback = onStreamData || null;
    this.onDisconnectCallback = onDisconnect || null;
    this.onDiagCallback = onDiagEvent || null;

    try {
      this.server = await this.device.gatt?.connect();
      if (!this.server) {
        throw new Error('No se pudo conectar al servidor GATT');
      }

      console.log('Conectado al servidor GATT del ESP32');
      const service = await this.server.getPrimaryService(ESP32_BLE_CONFIG.SERVICE_UUID);
      this.characteristic = await service.getCharacteristic(ESP32_BLE_CONFIG.CHARACTERISTIC_UUID);

      // Eventos de estabilización (CONTACTO, CAPTURA_LISTA, ...). Es opcional: un firmware sin
      // esta característica sigue funcionando y el tiempo se mide con el reloj de la app.
      try {
        this.diagCharacteristic = await service.getCharacteristic(ESP32_BLE_CONFIG.DIAG_CHARACTERISTIC_UUID);
        this.diagCharacteristic.addEventListener('characteristicvaluechanged', (event: any) => {
          const diag = parseDiagEvent(new TextDecoder('utf-8').decode(event.target.value));
          if (diag) {
            console.log(`[ESP32] ${diag.trial},${diag.event},${diag.elapsedMs}`);
            if (this.onDiagCallback) this.onDiagCallback(diag);
          }
        });
        await this.diagCharacteristic.startNotifications();
      } catch (err) {
        console.warn('El ESP32 no expone la característica de diagnóstico:', err);
        this.diagCharacteristic = null;
      }

      // Iniciar notificaciones para streaming en vivo
      await this.characteristic.startNotifications();

      return new Promise<IoTData>((resolve, reject) => {
        let firstResolved = false;

        const handleNotification = (event: any) => {
          const value = event.target.value;
          const decoder = new TextDecoder('utf-8');
          const jsonStr = decoder.decode(value);

          try {
            const liveData = parseIoTData(jsonStr);

            if (this.onDataCallback) {
              this.onDataCallback(liveData);
            }

            if (!firstResolved) {
              firstResolved = true;
              resolve(liveData);
            }
          } catch (err) {
            console.error('Error al decodificar paquete BLE JSON:', err, jsonStr);
          }
        };

        this.characteristic.addEventListener('characteristicvaluechanged', handleNotification);

        // Si tarda más de 3 segundos en emitir el primer paquete, resolver con lectura directa
        setTimeout(async () => {
          if (!firstResolved) {
            firstResolved = true;
            try {
              const rawVal = await this.characteristic.readValue();
              const decoder = new TextDecoder('utf-8');
              resolve(parseIoTData(decoder.decode(rawVal)));
            } catch (err) {
              // No se genera ningún dato simulado: se propaga el fallo para que el llamador
              // informe al médico y deje los signos vitales en captura manual (RF-03).
              reject(new Error('No se recibió señal del sensor IoT (timeout sin datos)'));
            }
          }
        }, 3000);
      });

    } catch (error) {
      console.warn('No se pudo establecer conexión GATT real con el ESP32:', error);
      // No se genera ningún dato simulado: se propaga el fallo para que el llamador
      // informe al médico y deje los signos vitales en captura manual (RF-03).
      throw error;
    }
  }

  disconnect() {
    // Desconexión solicitada por la app: se anula el callback antes de cerrar GATT
    // para que el evento 'gattserverdisconnected' no se reporte como inesperado.
    this.onDisconnectCallback = null;
    this.onDataCallback = null;
    this.onDiagCallback = null;
    if (this.device && this.device.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.device = null;
    this.server = null;
    this.characteristic = null;
    this.diagCharacteristic = null;
  }

  onDisconnected = () => {
    console.log('Dispositivo ESP32 desconectado');
    const callback = this.onDisconnectCallback;
    this.onDisconnectCallback = null;
    this.onDataCallback = null;
    this.onDiagCallback = null;
    this.server = null;
    this.characteristic = null;
    this.diagCharacteristic = null;
    if (callback) callback();
  };
}