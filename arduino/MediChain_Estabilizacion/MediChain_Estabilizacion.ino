// ============================================================
// MediChain ESP32: medición de tiempos de estabilización
// ============================================================
// Librerías (Gestor de librerías del IDE de Arduino):
//   - "SparkFun MAX3010x Pulse and Proximity Sensor Library"
//   - "Adafruit MLX90614 Library"
//   - BLE: incluida en el core "esp32 by Espressif Systems"
// Placa: "ESP32 Dev Module"
//
// Salida CSV por USB (115200 baudios):
//   ENSAYO,EVENTO,TIEMPO_MS
// TIEMPO_MS se mide desde CONTACTO (primera muestra IR sobre el
// umbral). Las líneas que empiezan con '#' son informativas y no
// forman parte del CSV.
//
// Eventos de cada ensayo:
//   CONTACTO             primera muestra con dedo (t = 0)
//   SPO2_PRIMER_CALCULO  primer valor de SpO2 (primer latido detectado)
//   FC_PRIMER_VALOR      primer intervalo RR válido
//   SPO2_ESTABLE         rango de SpO2 <= 1 punto durante 3 s
//   FC_ESTABLE           5 intervalos RR con CV < 10 %
//   TEMP_ESTABLE         rango <= 0.2 °C y |pendiente| <= 0.03 °C/s en 3 s
//   CAPTURA_LISTA        SpO2, FC y temperatura estables a la vez
//   INCOMPLETO           retiro del dedo antes de CAPTURA_LISTA
//   TIMEOUT              60 s sin CAPTURA_LISTA
//   RETIRO               retiro confirmado del dedo
//
// El tiempo de captura es CAPTURA_LISTA. No debe utilizarse
// RETIRO como tiempo de captura.
// ============================================================

#include <Wire.h>
#include "MAX30105.h"
#include <Adafruit_MLX90614.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// Hardware
#define I2C_SDA       21
#define I2C_SCL       22
#define FREQ_I2C      100000
#define MAX30102_ADDR 0x57

// BLE (deben coincidir con ESP32_BLE_CONFIG en src/services/bluetoothService.ts)
#define BLE_DEVICE_NAME    "MediChain_IoT"
#define BLE_SERVICE_UUID   "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define BLE_CHAR_UUID      "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define BLE_DIAG_CHAR_UUID "9c1e7a42-5d3b-4f86-a0e2-7b4d1c6f8e35"
#define BLE_MTU            185   // El JSON principal ocupa ~95 bytes
#define INTERVALO_ENVIO_MS 300
#define ESPERA_ADVERTISING_MS 300

// Temperatura
#define CAL_A             1.32f
#define CAL_B             1.5f
#define UMBRAL_TEMP_DEDO  20.0f   // Umbral bajo para no descartar lecturas superficiales válidas
#define INTERVALO_TEMP_MS 500

// Detección del dedo
#define UMBRAL_DEDO               50000
#define MUESTRAS_CONFIRMAR_DEDO   20
#define MUESTRAS_CONFIRMAR_RETIRO 50

// Procesamiento PPG
#define TAM_BUFFER       100
#define N_SUAV           12     // Paso bajo: media móvil de 120 ms
#define N_INTERVALOS     5
#define MS_POR_MUESTRA   10
#define REFRACTARIO_MS   300
#define MAX_INTERVALO    2000
#define FRACCION_UMBRAL  0.30f  // Umbral del detector: 30 % de la amplitud del último segundo
#define PI_MIN_UMBRAL    0.001f // Umbral mínimo: 0.1 % del nivel DC
#define RR_MIN_RELATIVO  0.60f  // Intervalo válido: entre 0.6 y 1.5 veces la mediana
#define RR_MAX_RELATIVO  1.50f
#define RECHAZOS_REINICIO 3     // Rechazos seguidos que reinician la ventana de intervalos
#define MIN_INTERVALOS_RECHAZO 2 // Intervalos guardados a partir de los cuales se aplica el rechazo
#define N_RAZONES        5      // SpO2 con la mediana de R de los últimos 5 latidos

// Criterios de estabilidad
#define INTERVALO_EVAL_MS   250
#define VENTANA_ESTAB_MS    3000
#define N_HIST_SPO2         (VENTANA_ESTAB_MS / INTERVALO_EVAL_MS + 1)  // 13 puntos = 3 s
#define RANGO_MAX_SPO2      1.0f
#define CV_MAX_FC           0.10f
#define N_HIST_TEMP         (VENTANA_ESTAB_MS / INTERVALO_TEMP_MS + 1)  // 7 lecturas = 3 s
#define RANGO_MAX_TEMP      0.2f
#define PENDIENTE_MAX_TEMP  0.03f   // °C/s

// 1 = imprime cada lectura de temperatura durante la captura (líneas '#')
#define DIAG_TEMP           1

// 1 = imprime el estado de los tres criterios cada vez que cambia (líneas '#')
#define DIAG_ESTADO         1

// 1 = imprime el estado de la señal PPG una vez por segundo (líneas '#')
#define DIAG_PPG            1
#define IR_SATURACION       260000   // Cerca del máximo del ADC de 18 bits (262143)

// Calidad de señal ("poor_signal")
#define CV_SENAL_DEFICIENTE 0.20f
#define SIN_LATIDO_MAX_MS   3000
#define PERDIDA_RECIENTE_MS 1000

// Ensayo
#define TIMEOUT_CAPTURA_MS  60000UL

MAX30105 sensorPPG;
Adafruit_MLX90614 sensorTemp;

bool ppgDisponible = false;
bool tempDisponible = false;

BLEServer *servidorBLE = nullptr;
BLECharacteristic *caracteristicaDatos = nullptr;
BLECharacteristic *caracteristicaDiagnostico = nullptr;

// Se modifican desde la tarea BLE y se leen desde loop()
volatile bool clienteBLEConectado = false;
volatile bool reanudarAdvertising = false;
volatile unsigned long instanteDesconexion = 0;

// Los callbacks BLE no escriben en Serial: el mensaje lo imprime loop()
// para que no se intercale con una línea del CSV.
class CallbacksServidor : public BLEServerCallbacks {
  void onConnect(BLEServer *servidor) override {
    clienteBLEConectado = true;
  }

  void onDisconnect(BLEServer *servidor) override {
    clienteBLEConectado = false;

    // El advertising se reanuda desde loop() sin bloquear la tarea BLE
    instanteDesconexion = millis();
    reanudarAdvertising = true;
  }
};

void iniciarBLE() {
  BLEDevice::init(BLE_DEVICE_NAME);
  BLEDevice::setMTU(BLE_MTU);

  servidorBLE = BLEDevice::createServer();
  servidorBLE->setCallbacks(new CallbacksServidor());

  BLEService *servicio =
      servidorBLE->createService(BLE_SERVICE_UUID);

  caracteristicaDatos = servicio->createCharacteristic(
      BLE_CHAR_UUID,
      BLECharacteristic::PROPERTY_READ |
      BLECharacteristic::PROPERTY_NOTIFY
  );

  caracteristicaDatos->addDescriptor(new BLE2902());

  caracteristicaDatos->setValue(
      "{\"hr\":0,\"spo2\":0,\"temp\":0,\"finger\":false,"
      "\"ready\":false,\"quality\":\"measuring\"}"
  );

  caracteristicaDiagnostico =
      servicio->createCharacteristic(
          BLE_DIAG_CHAR_UUID,
          BLECharacteristic::PROPERTY_READ |
          BLECharacteristic::PROPERTY_NOTIFY
      );

  caracteristicaDiagnostico->addDescriptor(new BLE2902());
  caracteristicaDiagnostico->setValue("0,-,0");

  servicio->start();

  BLEAdvertising *publicidad =
      BLEDevice::getAdvertising();

  publicidad->addServiceUUID(BLE_SERVICE_UUID);
  publicidad->setScanResponse(true);

  BLEDevice::startAdvertising();

  Serial.println("# BLE: advertising iniciado");
}

// ============================================================
// Procesamiento PPG
// ============================================================
// 1. Paso bajo: media móvil de N_SUAV muestras (120 ms) sobre IR y rojo.
// 2. Detector de latidos por prominencia sobre la señal IR suavizada e
//    invertida (absorción, pico = sístole): un pico se confirma cuando la
//    señal cae más que el umbral desde
//    el máximo, y el siguiente pico solo se busca después de subir más
//    que el umbral desde el valle. Umbral = FRACCION_UMBRAL x amplitud
//    pico a pico de la señal suavizada en el último segundo (mínimo
//    PI_MIN_UMBRAL x nivel DC). No depende de cruzar la media.
// 3. Intervalos RR: se aceptan entre REFRACTARIO_MS y MAX_INTERVALO y,
//    con MIN_INTERVALOS_RECHAZO o más intervalos guardados, solo si están entre
//    RR_MIN_RELATIVO y RR_MAX_RELATIVO veces la mediana (latido falso
//    o perdido). RECHAZOS_REINICIO rechazos seguidos reinician la
//    ventana: la frecuencia cambió de verdad.
// 4. SpO2 por latido: AC = prominencia del pico (IR y rojo en los
//    mismos instantes), DC = media del buffer de 1 s;
//    R = (AC_rojo / DC_rojo) / (AC_IR / DC_IR). SpO2 = 110 - 25 x
//    mediana de R de los últimos N_RAZONES latidos (un latido con el
//    canal rojo alterado no mueve el valor).

class AnalizadorPPG {
public:
  float bpm = 0;
  float spo2 = 0;

  // Diagnóstico
  float diagDcIR = 0;
  float diagAcIR = 0;
  uint32_t diagMaxIR = 0;
  float diagRazon = 0;
  float diagSpO2Inst = 0;
  float diagUmbral = 0;
  unsigned long diagLatidos = 0;     // Picos confirmados (referencias + aceptados + rechazados)
  unsigned long diagRefractario = 0; // Picos descartados por < REFRACTARIO_MS
  unsigned long diagRechazados = 0;  // Intervalos fuera de [0.6, 1.5] x mediana

  // Intervalos guardados, del más antiguo al más reciente, separados por '/'
  void intervalosTexto(char *destino, size_t tamano) const {
    destino[0] = '\0';
    size_t usado = 0;

    for (int k = 0; k < numeroIntervalos; k++) {
      int i = (indiceIntervalo - numeroIntervalos + k + N_INTERVALOS) % N_INTERVALOS;
      int escrito = snprintf(destino + usado, tamano - usado, k ? "/%lu" : "%lu", intervalos[i]);

      if (escrito < 0 || (size_t)escrito >= tamano - usado) {
        break;
      }

      usado += escrito;
    }
  }

  // Nivel DC, pulso pico a pico y máximo del buffer crudo de 1 s (solo diagnóstico)
  void actualizarDiagCrudo() {
    if (cantidad == 0) {
      return;
    }

    uint32_t maximo = 0;
    uint32_t minimo = UINT32_MAX;

    for (int i = 0; i < cantidad; i++) {
      maximo = max(maximo, bufferIR[i]);
      minimo = min(minimo, bufferIR[i]);
    }

    diagDcIR = (float)sumaBufferIR / cantidad;
    diagAcIR = (float)(maximo - minimo);
    diagMaxIR = maximo;
  }

  AnalizadorPPG() {
    reiniciar();
  }

  void reiniciar() {
    indice = 0;
    cantidad = 0;
    sumaBufferIR = 0;
    sumaBufferRojo = 0;

    bpm = 0;
    spo2 = 0;
    spo2Inicializada = false;

    muestrasTotales = 0;
    ultimoLatido = 0;
    ultimaDeteccion = 0;
    existeLatidoAnterior = false;

    numeroIntervalos = 0;
    indiceIntervalo = 0;
    rechazosSeguidos = 0;

    numeroRazones = 0;
    indiceRazon = 0;

    sumaSuavIR = 0;
    sumaSuavRojo = 0;
    indiceSuavizado = 0;
    numeroSuavizado = 0;

    for (int i = 0; i < N_SUAV; i++) {
      bufferSuavIR[i] = 0;
      bufferSuavRojo[i] = 0;
    }

    indiceHistorial = 0;
    cantidadHistorial = 0;

    reiniciarDetector();

    diagLatidos = 0;
    diagRefractario = 0;
    diagRechazados = 0;
    diagRazon = 0;
    diagSpO2Inst = 0;
    diagUmbral = 0;
  }

  // Pérdida momentánea de contacto: el próximo pico solo sirve de
  // referencia, así ningún intervalo RR atraviesa el hueco. Los
  // intervalos ya guardados se conservan.
  void perdidaContacto() {
    existeLatidoAnterior = false;
    reiniciarDetector();
  }

  void procesar(uint32_t ir, uint32_t rojo) {
    // Buffer crudo de 1 s: nivel DC
    if (cantidad == TAM_BUFFER) {
      sumaBufferIR -= bufferIR[indice];
      sumaBufferRojo -= bufferRojo[indice];
    }

    bufferIR[indice] = ir;
    bufferRojo[indice] = rojo;
    sumaBufferIR += ir;
    sumaBufferRojo += rojo;

    indice = (indice + 1) % TAM_BUFFER;

    if (cantidad < TAM_BUFFER) {
      cantidad++;
    }

    muestrasTotales++;

    // Paso bajo (media móvil de N_SUAV muestras)
    sumaSuavIR -= bufferSuavIR[indiceSuavizado];
    sumaSuavRojo -= bufferSuavRojo[indiceSuavizado];
    bufferSuavIR[indiceSuavizado] = ir;
    bufferSuavRojo[indiceSuavizado] = rojo;
    sumaSuavIR += ir;
    sumaSuavRojo += rojo;

    indiceSuavizado = (indiceSuavizado + 1) % N_SUAV;

    if (numeroSuavizado < N_SUAV) {
      numeroSuavizado++;
    }

    // Señal invertida (absorción): el pico es la sístole, el punto más nítido
    // del pulso. Los picos de intensidad caen en la diástole, que es plana.
    float suaveIR = -(float)sumaSuavIR / numeroSuavizado;
    float suaveRojo = -(float)sumaSuavRojo / numeroSuavizado;

    // Último segundo de la señal suavizada, para el umbral adaptativo
    historialSuave[indiceHistorial] = suaveIR;
    indiceHistorial = (indiceHistorial + 1) % TAM_BUFFER;

    if (cantidadHistorial < TAM_BUFFER) {
      cantidadHistorial++;
    }

    if (cantidad == TAM_BUFFER && cantidadHistorial == TAM_BUFFER) {
      detectarLatido(suaveIR, suaveRojo);
    }
  }

  bool bufferCompleto() const {
    return cantidad == TAM_BUFFER;
  }

  // Ya hay un primer valor de SpO2 (primer latido con AC válido)
  bool spo2Lista() const {
    return spo2Inicializada;
  }

  bool primerValorFC() const {
    return numeroIntervalos >= 1 &&
           bpm >= 30.0f &&
           bpm <= 200.0f;
  }

  bool intervalosCompletos() const {
    return numeroIntervalos == N_INTERVALOS;
  }

  // CV = desviación estándar muestral / media de los intervalos RR
  float coeficienteVariacion() const {
    if (numeroIntervalos < 2) {
      return 1.0f;
    }

    float media = 0;

    for (int i = 0; i < numeroIntervalos; i++) {
      media += intervalos[i];
    }

    media /= numeroIntervalos;

    float sumaCuadrados = 0;

    for (int i = 0; i < numeroIntervalos; i++) {
      float d = intervalos[i] - media;
      sumaCuadrados += d * d;
    }

    float desviacion =
        sqrtf(sumaCuadrados / (numeroIntervalos - 1));

    return desviacion / media;
  }

  bool fcEstable() const {
    return intervalosCompletos() &&
           bpm >= 30.0f &&
           bpm <= 200.0f &&
           coeficienteVariacion() < CV_MAX_FC;
  }

  // Con el buffer lleno no se ha confirmado ningún pico en 3 s
  bool sinLatidoReciente() const {
    return bufferCompleto() &&
           muestrasTotales * MS_POR_MUESTRA - ultimaDeteccion >
               SIN_LATIDO_MAX_MS;
  }

private:
  uint32_t bufferIR[TAM_BUFFER];
  uint32_t bufferRojo[TAM_BUFFER];
  uint32_t sumaBufferIR = 0;
  uint32_t sumaBufferRojo = 0;

  int indice = 0;
  int cantidad = 0;

  bool spo2Inicializada = false;

  uint32_t bufferSuavIR[N_SUAV];
  uint32_t bufferSuavRojo[N_SUAV];
  uint32_t sumaSuavIR = 0;
  uint32_t sumaSuavRojo = 0;
  int indiceSuavizado = 0;
  int numeroSuavizado = 0;

  float historialSuave[TAM_BUFFER];
  int indiceHistorial = 0;
  int cantidadHistorial = 0;

  // Estado del detector por prominencia
  bool detectorIniciado = false;
  bool buscandoPico = false;
  float picoValor = 0;
  float picoRojo = 0;
  unsigned long picoMuestra = 0;
  float valleValor = 0;
  float valleRojo = 0;

  unsigned long muestrasTotales = 0;
  unsigned long ultimoLatido = 0;
  unsigned long ultimaDeteccion = 0;
  bool existeLatidoAnterior = false;

  unsigned long intervalos[N_INTERVALOS];
  int numeroIntervalos = 0;
  int indiceIntervalo = 0;
  int rechazosSeguidos = 0;

  float razones[N_RAZONES];
  int numeroRazones = 0;
  int indiceRazon = 0;

  void reiniciarDetector() {
    detectorIniciado = false;
    buscandoPico = false;
  }

  float medianaIntervalos() {
    unsigned long copia[N_INTERVALOS];

    for (int i = 0; i < numeroIntervalos; i++) {
      copia[i] = intervalos[i];
    }

    for (int i = 1; i < numeroIntervalos; i++) {
      unsigned long valor = copia[i];
      int j = i - 1;

      while (j >= 0 && copia[j] > valor) {
        copia[j + 1] = copia[j];
        j--;
      }

      copia[j + 1] = valor;
    }

    return (float)copia[numeroIntervalos / 2];
  }

  void detectarLatido(float suaveIR, float suaveRojo) {
    float maximo = historialSuave[0];
    float minimo = historialSuave[0];

    for (int i = 1; i < TAM_BUFFER; i++) {
      maximo = max(maximo, historialSuave[i]);
      minimo = min(minimo, historialSuave[i]);
    }

    float dcIR = (float)sumaBufferIR / TAM_BUFFER;

    float umbral =
        max(FRACCION_UMBRAL * (maximo - minimo), PI_MIN_UMBRAL * dcIR);

    diagUmbral = umbral;

    if (!detectorIniciado) {
      detectorIniciado = true;
      buscandoPico = false;
      valleValor = suaveIR;
      valleRojo = suaveRojo;
      return;
    }

    if (buscandoPico) {
      if (suaveIR > picoValor) {
        picoValor = suaveIR;
        picoRojo = suaveRojo;
        picoMuestra = muestrasTotales;
      }

      // Pico confirmado: la señal cayó más que el umbral desde el máximo
      if (picoValor - suaveIR > umbral) {
        registrarLatido(
            picoMuestra,
            picoValor - valleValor,
            picoRojo - valleRojo
        );

        buscandoPico = false;
        valleValor = suaveIR;
        valleRojo = suaveRojo;
      }
    } else {
      if (suaveIR < valleValor) {
        valleValor = suaveIR;
        valleRojo = suaveRojo;
      }

      // Valle superado: la señal subió más que el umbral, se busca el pico
      if (suaveIR - valleValor > umbral) {
        buscandoPico = true;
        picoValor = suaveIR;
        picoRojo = suaveRojo;
        picoMuestra = muestrasTotales;
      }
    }
  }

  void registrarLatido(unsigned long muestra, float acIR, float acRojo) {
    unsigned long instante = muestra * MS_POR_MUESTRA;

    if (!existeLatidoAnterior ||
        instante - ultimoLatido > MAX_INTERVALO) {

      ultimoLatido = instante;
      ultimaDeteccion = instante;
      existeLatidoAnterior = true;
      diagLatidos++;

      actualizarSpO2(acIR, acRojo);
      return;
    }

    unsigned long diferencia = instante - ultimoLatido;

    if (diferencia < REFRACTARIO_MS) {
      diagRefractario++;
      return;
    }

    diagLatidos++;
    ultimoLatido = instante;
    ultimaDeteccion = instante;

    // Intervalo implausible frente a la mediana: latido falso o perdido
    if (numeroIntervalos >= MIN_INTERVALOS_RECHAZO) {
      float mediana = medianaIntervalos();

      if (diferencia < RR_MIN_RELATIVO * mediana ||
          diferencia > RR_MAX_RELATIVO * mediana) {

        diagRechazados++;
        rechazosSeguidos++;

        if (rechazosSeguidos < RECHAZOS_REINICIO) {
          return;
        }

        // Varios rechazos seguidos: la frecuencia cambió, la ventana vuelve a empezar
        numeroIntervalos = 0;
        indiceIntervalo = 0;
      }
    }

    rechazosSeguidos = 0;

    intervalos[indiceIntervalo] = diferencia;
    indiceIntervalo = (indiceIntervalo + 1) % N_INTERVALOS;

    if (numeroIntervalos < N_INTERVALOS) {
      numeroIntervalos++;
    }

    bpm = 60000.0f / medianaIntervalos();

    actualizarSpO2(acIR, acRojo);
  }

  void actualizarSpO2(float acIR, float acRojo) {
    float dcIR = (float)sumaBufferIR / TAM_BUFFER;
    float dcRojo = (float)sumaBufferRojo / TAM_BUFFER;

    if (acIR <= 0 || acRojo <= 0 || dcIR <= 0 || dcRojo <= 0) {
      return;
    }

    float razon =
        (acRojo / dcRojo) /
        (acIR / dcIR);

    diagRazon = razon;
    diagSpO2Inst = constrain(110.0f - 25.0f * razon, 80.0f, 99.9f);

    razones[indiceRazon] = razon;
    indiceRazon = (indiceRazon + 1) % N_RAZONES;

    if (numeroRazones < N_RAZONES) {
      numeroRazones++;
    }

    // Mediana de R de los últimos latidos (ordenamiento por inserción)
    float copia[N_RAZONES];

    for (int i = 0; i < numeroRazones; i++) {
      copia[i] = razones[i];
    }

    for (int i = 1; i < numeroRazones; i++) {
      float valor = copia[i];
      int j = i - 1;

      while (j >= 0 && copia[j] > valor) {
        copia[j + 1] = copia[j];
        j--;
      }

      copia[j + 1] = valor;
    }

    float razonMediana = copia[numeroRazones / 2];

    spo2 =
        constrain(
            110.0f - 25.0f * razonMediana,
            80.0f,
            99.9f
        );

    spo2Inicializada = true;
  }
};

AnalizadorPPG analizador;

// Una línea por segundo: nivel DC, pulso pico a pico, índice de perfusión (AC/DC),
// saturación del ADC, umbral del detector, R y SpO2 del último latido, latidos e intervalos RR
void imprimirDiagPPG(unsigned long tiempo) {
  analizador.actualizarDiagCrudo();

  char textoIntervalos[48];
  analizador.intervalosTexto(textoIntervalos, sizeof(textoIntervalos));

  float perfusion =
      analizador.diagDcIR > 0 ? 100.0f * analizador.diagAcIR / analizador.diagDcIR : 0;

  Serial.printf(
      "# PPG t=%lu dc=%.0f ac=%.0f PI=%.2f%% max=%lu%s umbral=%.0f R=%.3f spo2i=%.1f spo2=%.1f bpm=%.1f lat=%lu refr=%lu rech=%lu rr=%s\n",
      tiempo,
      analizador.diagDcIR,
      analizador.diagAcIR,
      perfusion,
      (unsigned long)analizador.diagMaxIR,
      analizador.diagMaxIR >= IR_SATURACION ? "(SATURADO)" : "",
      analizador.diagUmbral,
      analizador.diagRazon,
      analizador.diagSpO2Inst,
      analizador.spo2,
      analizador.bpm,
      analizador.diagLatidos,
      analizador.diagRefractario,
      analizador.diagRechazados,
      textoIntervalos
  );
}

// ============================================================
// Ventana de estabilidad de SpO2 (un punto cada 250 ms)
// ============================================================

float histSpO2[N_HIST_SPO2];
unsigned long tHistSpO2[N_HIST_SPO2];
int indiceHistSpO2 = 0;
int cantidadHistSpO2 = 0;
float rangoSpO2Actual = -1;     // Diagnóstico: rango de la ventana; -1 = ventana incompleta

void reiniciarHistSpO2() {
  indiceHistSpO2 = 0;
  cantidadHistSpO2 = 0;
}

void agregarHistSpO2(float valor, unsigned long instante) {
  histSpO2[indiceHistSpO2] = valor;
  tHistSpO2[indiceHistSpO2] = instante;

  indiceHistSpO2 = (indiceHistSpO2 + 1) % N_HIST_SPO2;

  if (cantidadHistSpO2 < N_HIST_SPO2) {
    cantidadHistSpO2++;
  }
}

// Estable: la ventana cubre >= 3 s y max - min <= 1 punto
bool spo2EstableAhora() {
  rangoSpO2Actual = -1;

  if (cantidadHistSpO2 < N_HIST_SPO2) {
    return false;
  }

  int masAntiguo = indiceHistSpO2;
  int masReciente = (indiceHistSpO2 + N_HIST_SPO2 - 1) % N_HIST_SPO2;

  if (tHistSpO2[masReciente] - tHistSpO2[masAntiguo] < VENTANA_ESTAB_MS) {
    return false;
  }

  float minimo = histSpO2[0];
  float maximo = histSpO2[0];

  for (int i = 1; i < N_HIST_SPO2; i++) {
    minimo = min(minimo, histSpO2[i]);
    maximo = max(maximo, histSpO2[i]);
  }

  rangoSpO2Actual = maximo - minimo;

  return maximo - minimo <= RANGO_MAX_SPO2;
}

// ============================================================
// Temperatura (una lectura cada 500 ms)
// ============================================================

float histTemp[N_HIST_TEMP];
unsigned long tHistTemp[N_HIST_TEMP];
int indiceHistTemp = 0;
int cantidadHistTemp = 0;

float temperaturaActual = 0;    // Promedio calibrado de la ventana
bool tempEstableActual = false;
float rangoTempActual = 0;      // Diagnóstico: último rango de la ventana
float pendienteTempActual = 0;  // Diagnóstico: última pendiente (°C/s)

// La ventana debe ser continua: se vacía al iniciar el ensayo y ante
// una lectura fallida o de ambiente
void reiniciarHistTemp() {
  indiceHistTemp = 0;
  cantidadHistTemp = 0;
  tempEstableActual = false;
}

void evaluarVentanaTemp() {
  int primero =
      (indiceHistTemp - cantidadHistTemp + N_HIST_TEMP) % N_HIST_TEMP;
  int ultimo =
      (indiceHistTemp + N_HIST_TEMP - 1) % N_HIST_TEMP;

  float suma = 0;
  float minimo = histTemp[primero];
  float maximo = histTemp[primero];

  for (int k = 0; k < cantidadHistTemp; k++) {
    float valor = histTemp[(primero + k) % N_HIST_TEMP];

    suma += valor;
    minimo = min(minimo, valor);
    maximo = max(maximo, valor);
  }

  temperaturaActual = suma / cantidadHistTemp;
  rangoTempActual = maximo - minimo;
  pendienteTempActual = 0;

  if (cantidadHistTemp < N_HIST_TEMP ||
      tHistTemp[ultimo] - tHistTemp[primero] < VENTANA_ESTAB_MS) {
    tempEstableActual = false;
    return;
  }

  // Pendiente por mínimos cuadrados: b = Σ(x - x̄)(y - ȳ) / Σ(x - x̄)²
  // con x en segundos desde la primera lectura de la ventana
  float mediaX = 0;

  for (int k = 0; k < N_HIST_TEMP; k++) {
    int i = (primero + k) % N_HIST_TEMP;
    mediaX += (tHistTemp[i] - tHistTemp[primero]) / 1000.0f;
  }

  mediaX /= N_HIST_TEMP;

  float numerador = 0;
  float denominador = 0;

  for (int k = 0; k < N_HIST_TEMP; k++) {
    int i = (primero + k) % N_HIST_TEMP;
    float dx = (tHistTemp[i] - tHistTemp[primero]) / 1000.0f - mediaX;

    numerador += dx * (histTemp[i] - temperaturaActual);
    denominador += dx * dx;
  }

  float pendiente =
      denominador > 0 ? numerador / denominador : 0;

  pendienteTempActual = pendiente;

  tempEstableActual =
      maximo - minimo <= RANGO_MAX_TEMP &&
      fabsf(pendiente) <= PENDIENTE_MAX_TEMP;
}

// Definidas en "Instrumentación del ensayo"
extern bool capturaEnCurso;
extern unsigned long inicioContacto;

void leerTemperatura(unsigned long instante) {
  if (!tempDisponible) {
    return;
  }

  float lecturaObjeto = sensorTemp.readObjectTempC();
  float lecturaAmbiente = sensorTemp.readAmbientTempC();

  if (isnan(lecturaObjeto) || isnan(lecturaAmbiente)) {
    reiniciarHistTemp();

    if (DIAG_TEMP && capturaEnCurso) {
      Serial.println("# TEMP ERROR: lectura NaN");
    }

    return;
  }

  float lecturaCalibrada = CAL_A * lecturaObjeto + CAL_B;

  if (DIAG_TEMP && capturaEnCurso) {
    Serial.printf(
        "# MLX t=%lu ambiente=%.2f objeto=%.2f calibrada=%.2f\n",
        instante - inicioContacto,
        lecturaAmbiente,
        lecturaObjeto,
        lecturaCalibrada
    );
  }

  if (lecturaObjeto < UMBRAL_TEMP_DEDO) {
    reiniciarHistTemp();

    if (DIAG_TEMP && capturaEnCurso) {
      Serial.printf(
          "# TEMP t=%lu objeto=%.2f DESCARTADA (< %.1f): ventana reiniciada\n",
          instante - inicioContacto,
          lecturaObjeto,
          UMBRAL_TEMP_DEDO
      );
    }

    return;
  }

  histTemp[indiceHistTemp] = lecturaCalibrada;
  tHistTemp[indiceHistTemp] = instante;

  indiceHistTemp = (indiceHistTemp + 1) % N_HIST_TEMP;

  if (cantidadHistTemp < N_HIST_TEMP) {
    cantidadHistTemp++;
  }

  evaluarVentanaTemp();

  if (DIAG_TEMP && capturaEnCurso) {
    Serial.printf(
        "# TEMP t=%lu objeto=%.2f cal=%.2f n=%d rango=%.2f pend=%.3f estable=%d\n",
        instante - inicioContacto,
        lecturaObjeto,
        lecturaCalibrada,
        cantidadHistTemp,
        rangoTempActual,
        pendienteTempActual,
        tempEstableActual ? 1 : 0
    );
  }
}

// ============================================================
// Instrumentación del ensayo
// ============================================================

int numeroEnsayo = 0;

bool ensayoActivo = false;     // De CONTACTO a RETIRO
bool capturaEnCurso = false;   // De CONTACTO a CAPTURA_LISTA / TIMEOUT / INCOMPLETO

bool eventoSpO2Primero = false;
bool eventoSpO2Estable = false;
bool eventoFCPrimero = false;
bool eventoFCEstable = false;
bool eventoTempEstable = false;
bool eventoCapturaLista = false;
bool eventoTimeout = false;

unsigned long inicioContacto = 0;

bool huboPerdidaContacto = false;
unsigned long ultimaPerdidaContacto = 0;

// Valores congelados en CAPTURA_LISTA (los que llenan el formulario)
float hrCapturada = 0;
float spo2Capturada = 0;
float tempCapturada = 0;

void notificarEventoBLE(
    const char *codigo,
    unsigned long tiempo
) {
  if (!caracteristicaDiagnostico) {
    return;
  }

  // Formato corto: ensayo,código,tiempo
  char mensaje[32];

  snprintf(
      mensaje,
      sizeof(mensaje),
      "%d,%s,%lu",
      numeroEnsayo,
      codigo,
      tiempo
  );

  caracteristicaDiagnostico->setValue(
      (uint8_t *)mensaje,
      strlen(mensaje)
  );

  if (clienteBLEConectado) {
    caracteristicaDiagnostico->notify();
  }
}

unsigned long registrarEvento(
    const char *nombre,
    const char *codigo
) {
  unsigned long tiempo =
      millis() - inicioContacto;

  Serial.printf(
      "%d,%s,%lu\n",
      numeroEnsayo,
      nombre,
      tiempo
  );

  notificarEventoBLE(
      codigo,
      tiempo
  );

  return tiempo;
}

void iniciarEnsayo(
    unsigned long tiempoPrimerContacto
) {
  numeroEnsayo++;
  inicioContacto = tiempoPrimerContacto;

  ensayoActivo = true;
  capturaEnCurso = true;

  eventoSpO2Primero = false;
  eventoSpO2Estable = false;
  eventoFCPrimero = false;
  eventoFCEstable = false;
  eventoTempEstable = false;
  eventoCapturaLista = false;
  eventoTimeout = false;

  huboPerdidaContacto = false;

  reiniciarHistSpO2();
  reiniciarHistTemp();
  temperaturaActual = 0;

  Serial.printf(
      "%d,CONTACTO,0\n",
      numeroEnsayo
  );

  notificarEventoBLE("C", 0);
}

void finalizarEnsayo() {
  if (!ensayoActivo) {
    return;
  }

  if (capturaEnCurso) {
    capturaEnCurso = false;
    registrarEvento("INCOMPLETO", "INC");
  }

  registrarEvento("RETIRO", "R");
  ensayoActivo = false;
}

// Eventos de primer valor: se revisan en cada muestra PPG
void revisarPPG() {
  if (!capturaEnCurso) {
    return;
  }

  if (!eventoSpO2Primero &&
      analizador.spo2Lista()) {

    eventoSpO2Primero = true;

    registrarEvento(
        "SPO2_PRIMER_CALCULO",
        "S1"
    );
  }

  if (!eventoFCPrimero &&
      analizador.primerValorFC()) {

    eventoFCPrimero = true;

    registrarEvento(
        "FC_PRIMER_VALOR",
        "F1"
    );
  }
}

bool huboPerdidaContactoActiva();

// Criterios de estabilidad: se evalúan cada 250 ms
void evaluarEstabilidad(unsigned long instante) {
  if (!capturaEnCurso) {
    return;
  }

  // Durante una pérdida de contacto no se agregan puntos a la ventana
  if (analizador.spo2Lista() &&
      !huboPerdidaContactoActiva()) {
    agregarHistSpO2(analizador.spo2, instante);
  }

  bool spo2Ok = spo2EstableAhora();
  bool fcOk = analizador.fcEstable();
  bool tempOk = tempEstableActual;

  // Una línea cada vez que cambia la combinación de los tres criterios
  if (DIAG_ESTADO) {
    static int estadoAnterior = -1;
    int estado = (spo2Ok ? 4 : 0) | (fcOk ? 2 : 0) | (tempOk ? 1 : 0);

    if (estado != estadoAnterior) {
      Serial.printf(
          "# ESTADO t=%lu SPO2=%d (rango=%.2f) FC=%d (5int=%d cv=%.3f) TEMP=%d (rango=%.2f pend=%.3f)\n",
          millis() - inicioContacto,
          spo2Ok ? 1 : 0,
          rangoSpO2Actual,
          fcOk ? 1 : 0,
          analizador.intervalosCompletos() ? 1 : 0,
          analizador.coeficienteVariacion(),
          tempOk ? 1 : 0,
          rangoTempActual,
          pendienteTempActual
      );

      estadoAnterior = estado;
    }
  }

  if (spo2Ok && !eventoSpO2Estable) {
    eventoSpO2Estable = true;
    registrarEvento("SPO2_ESTABLE", "S");
  }

  if (fcOk && !eventoFCEstable) {
    eventoFCEstable = true;
    registrarEvento("FC_ESTABLE", "F");
  }

  if (tempOk && !eventoTempEstable) {
    eventoTempEstable = true;
    registrarEvento("TEMP_ESTABLE", "T");
  }

  // Los tres criterios deben cumplirse en la misma evaluación
  if (spo2Ok && fcOk && tempOk) {
    hrCapturada = analizador.bpm;
    spo2Capturada = analizador.spo2;
    tempCapturada = temperaturaActual;

    eventoCapturaLista = true;
    capturaEnCurso = false;

    registrarEvento("CAPTURA_LISTA", "L");
    return;
  }

  if (millis() - inicioContacto >= TIMEOUT_CAPTURA_MS) {
    eventoTimeout = true;
    capturaEnCurso = false;

    registrarEvento("TIMEOUT", "TO");
  }
}

// ============================================================
// Recuperación I2C
// ============================================================

void recuperarBusI2C() {
  pinMode(I2C_SDA, INPUT_PULLUP);
  pinMode(I2C_SCL, OUTPUT_OPEN_DRAIN);

  for (int i = 0; i < 9; i++) {
    digitalWrite(I2C_SCL, LOW);
    delayMicroseconds(5);

    digitalWrite(I2C_SCL, HIGH);
    delayMicroseconds(5);
  }

  pinMode(I2C_SDA, OUTPUT_OPEN_DRAIN);

  digitalWrite(I2C_SDA, LOW);
  delayMicroseconds(5);

  digitalWrite(I2C_SCL, HIGH);
  delayMicroseconds(5);

  digitalWrite(I2C_SDA, HIGH);
  delayMicroseconds(5);
}

bool dispositivoI2CPresente(
    uint8_t direccion
) {
  Wire.beginTransmission(direccion);

  return Wire.endTransmission() == 0;
}

// ============================================================
// Estado principal
// ============================================================

int muestrasSinDedo =
    MUESTRAS_CONFIRMAR_RETIRO;

int muestrasConDedo = 0;

bool dedoConfirmado = false;

unsigned long posibleInicioContacto = 0;

unsigned long ultimoTiempoTemp = 0;
unsigned long ultimaEvaluacion = 0;
unsigned long ultimoEnvio = 0;

// Hay muestras sin dedo en curso dentro de un ensayo (aún sin confirmar retiro)
bool huboPerdidaContactoActiva() {
  return dedoConfirmado && muestrasSinDedo > 0;
}

const char *calidadSenal() {
  if (!dedoConfirmado) {
    return "measuring";
  }

  if (eventoCapturaLista) {
    return "stable";
  }

  if (eventoTimeout ||
      huboPerdidaContactoActiva()) {
    return "poor_signal";
  }

  if (huboPerdidaContacto &&
      millis() - ultimaPerdidaContacto < PERDIDA_RECIENTE_MS) {
    return "poor_signal";
  }

  if (analizador.sinLatidoReciente()) {
    return "poor_signal";
  }

  if (analizador.intervalosCompletos() &&
      analizador.coeficienteVariacion() >= CV_SENAL_DEFICIENTE) {
    return "poor_signal";
  }

  return "measuring";
}

void procesarFIFO() {
  sensorPPG.check();

  while (sensorPPG.available()) {
    uint32_t rojo =
        sensorPPG.getFIFORed();

    uint32_t ir =
        sensorPPG.getFIFOIR();

    sensorPPG.nextSample();

    if (ir >= UMBRAL_DEDO) {
      muestrasSinDedo = 0;

      if (!dedoConfirmado) {
        if (muestrasConDedo == 0) {
          posibleInicioContacto =
              millis();
        }

        muestrasConDedo++;

        if (muestrasConDedo >=
            MUESTRAS_CONFIRMAR_DEDO) {

          dedoConfirmado = true;

          analizador.reiniciar();

          iniciarEnsayo(
              posibleInicioContacto
          );
        }
      }

      if (dedoConfirmado) {
        analizador.procesar(
            ir,
            rojo
        );

        revisarPPG();
      }

    } else {
      muestrasConDedo = 0;

      if (dedoConfirmado) {
        // Inicio de una pérdida de contacto: se descarta el intervalo
        // RR en curso y la ventana de SpO2 vuelve a empezar
        if (muestrasSinDedo == 0) {
          huboPerdidaContacto = true;
          ultimaPerdidaContacto = millis();

          analizador.perdidaContacto();
          reiniciarHistSpO2();
        }

        muestrasSinDedo++;

        if (muestrasSinDedo >=
            MUESTRAS_CONFIRMAR_RETIRO) {

          finalizarEnsayo();

          dedoConfirmado = false;

          muestrasSinDedo =
              MUESTRAS_CONFIRMAR_RETIRO;

          analizador.reiniciar();
          reiniciarHistSpO2();
          reiniciarHistTemp();
          temperaturaActual = 0;
        }
      }
    }
  }
}

void enviarDatosBLE() {
  if (!clienteBLEConectado ||
      !caracteristicaDatos) {
    return;
  }

  float hrEnviar = 0;
  float spo2Enviar = 0;
  float tempEnviar = 0;

  bool listo =
      dedoConfirmado && eventoCapturaLista;

  if (listo) {
    hrEnviar = hrCapturada;
    spo2Enviar = spo2Capturada;
    tempEnviar = tempCapturada;
  } else if (dedoConfirmado) {
    // Valores en vivo (la app no los usa mientras ready sea false)
    if (analizador.primerValorFC()) {
      hrEnviar = analizador.bpm;
    }

    if (analizador.spo2Lista()) {
      spo2Enviar = analizador.spo2;
    }

    tempEnviar = temperaturaActual;
  }

  char json[160];

  snprintf(
      json,
      sizeof(json),
      "{\"hr\":%.1f,"
      "\"spo2\":%.1f,"
      "\"temp\":%.2f,"
      "\"finger\":%s,"
      "\"ready\":%s,"
      "\"quality\":\"%s\"}",
      hrEnviar,
      spo2Enviar,
      tempEnviar,
      dedoConfirmado ? "true" : "false",
      listo ? "true" : "false",
      calidadSenal()
  );

  caracteristicaDatos->setValue(
      (uint8_t *)json,
      strlen(json)
  );

  caracteristicaDatos->notify();
}

void atenderBLE(unsigned long ahora) {
  static bool conectadoAnterior = false;

  bool conectado = clienteBLEConectado;

  if (conectado != conectadoAnterior) {
    Serial.println(
        conectado
            ? "# BLE: aplicación conectada"
            : "# BLE: aplicación desconectada"
    );

    conectadoAnterior = conectado;
  }

  if (reanudarAdvertising &&
      ahora - instanteDesconexion >= ESPERA_ADVERTISING_MS) {

    reanudarAdvertising = false;
    BLEDevice::startAdvertising();

    Serial.println("# BLE: advertising reanudado");
  }
}

// ============================================================
// Setup
// ============================================================

void setup() {
  Serial.begin(115200);

  recuperarBusI2C();

  Wire.begin(
      I2C_SDA,
      I2C_SCL
  );

  Wire.setClock(FREQ_I2C);

  delay(1500);

  Serial.println(
      "\n# --- MEDICIÓN DE ESTABILIZACIÓN MEDICHAIN ---"
  );

  tempDisponible =
      sensorTemp.begin(
          MLX90614_I2CADDR,
          &Wire
      );

  if (dispositivoI2CPresente(
          MAX30102_ADDR) &&
      sensorPPG.begin(
          Wire,
          FREQ_I2C)) {

    // potencia LED, promedio, modo (Rojo + IR), 100 Hz, 411 us, rango ADC
    sensorPPG.setup(
        0x7F,
        1,
        2,
        100,
        411,
        16384
    );

    ppgDisponible = true;
  }

  Serial.printf(
      "# MLX90614: %s\n",
      tempDisponible
          ? "OK"
          : "NO DETECTADO"
  );

  Serial.printf(
      "# MAX30102: %s\n",
      ppgDisponible
          ? "OK"
          : "NO DETECTADO"
  );

  iniciarBLE();

  Serial.println(
      "ENSAYO,EVENTO,TIEMPO_MS"
  );

  ultimoTiempoTemp = millis();
  ultimaEvaluacion = millis();
  ultimoEnvio = millis();
}

// ============================================================
// Loop
// ============================================================

void loop() {
  unsigned long ahora = millis();

  atenderBLE(ahora);

  static unsigned long
      ultimoReintentoTemp = 0;

  if (!tempDisponible &&
      ahora - ultimoReintentoTemp >=
          2000) {

    ultimoReintentoTemp = ahora;

    tempDisponible =
        sensorTemp.begin(
            MLX90614_I2CADDR,
            &Wire
        );
  }

  if (ahora - ultimoTiempoTemp >=
      INTERVALO_TEMP_MS) {

    leerTemperatura(ahora);

    ultimoTiempoTemp = ahora;
  }

  if (ppgDisponible) {
    procesarFIFO();
  }

  if (ahora - ultimaEvaluacion >=
      INTERVALO_EVAL_MS) {

    evaluarEstabilidad(ahora);

    ultimaEvaluacion = ahora;
  }

  static unsigned long ultimoDiagPPG = 0;

  if (DIAG_PPG && capturaEnCurso &&
      ahora - ultimoDiagPPG >= 1000) {

    imprimirDiagPPG(millis() - inicioContacto);

    ultimoDiagPPG = ahora;
  }

  // Envío a MediChain cada 300 ms
  if (ahora - ultimoEnvio >=
      INTERVALO_ENVIO_MS) {

    enviarDatosBLE();

    ultimoEnvio = ahora;
  }

  delay(1);
}