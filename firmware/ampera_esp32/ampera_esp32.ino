// AMPERA - firmware do ESP32 DevKit V1
// Mede tensão (ZMPT101B) e corrente (SCT-013-000), calcula potência real e energia
// e envia um JSON a cada 10 segundos:
//   {"v":127.1,"i":7.85,"p":995.2,"fp":0.99,"e_wh":2.764}
// por HTTP(S) para POST <SERVIDOR_URL>/api/leitura/<DISPOSITIVO_ID> (USAR_HTTP 1)
// ou por MQTT no tópico ampera/<DISPOSITIVO_ID>/leitura (USAR_HTTP 0).
//
// Biblioteca necessária (Arduino IDE > Gerenciador de Bibliotecas): PubSubClient (Nick O'Leary).
//
// Ligações:
//   SCT-013 -> jack P2 -> resistor de carga 22 ohms em paralelo; um lado no ponto médio do
//              divisor (2 x 10 k entre 3V3 e GND, com capacitor de 10 uF do ponto médio ao GND),
//              o outro lado no GPIO 34.
//   ZMPT101B -> VCC em 3V3, GND em GND, OUT no GPIO 35.

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <PubSubClient.h>

// ---------- Configuração: preencha com os seus dados ----------
const char* WIFI_NOME = "SUA_REDE_2.4GHZ";
const char* WIFI_SENHA = "SENHA_DO_WIFI";

const char* DISPOSITIVO_ID = "loja";  // só letras, números, - e _

// Modo de envio: 1 = HTTP(S) direto para o servidor (ex.: Render), 0 = MQTT.
#define USAR_HTTP 1

// HTTP(S): endereço do servidor e o mesmo DEVICE_TOKEN do .env / do Render.
//   Na nuvem: "https://SEU-APP.onrender.com"   No computador: "http://192.168.0.10:3000"
const char* SERVIDOR_URL = "https://SEU-APP.onrender.com";
const char* TOKEN_DISPOSITIVO = "MESMO_DEVICE_TOKEN_DO_SERVIDOR";

// MQTT, broker embutido do servidor AMPERA: IP do computador na rede, porta 1883, USAR_TLS 0.
// MQTT, broker na nuvem (ex.: HiveMQ Cloud): endereço do cluster, porta 8883, USAR_TLS 1.
#define USAR_TLS 0
const char* MQTT_SERVIDOR = "192.168.0.10";
const uint16_t MQTT_PORTA = 1883;
const char* MQTT_USUARIO = "ampera";
const char* MQTT_SENHA = "MESMA_SENHA_DO_ARQUIVO_.env";

// ---------- Calibração (seção de calibração do guia de montagem) ----------
// CAL_CORRENTE = espiras do SCT-013-000 (2000) / resistor de carga (22 ohms).
// CAL_TENSAO: ajuste até a tensão do painel bater com a do multímetro
//             (novo = atual x tensão do multímetro / tensão mostrada).
float CAL_CORRENTE = 90.9;
float CAL_TENSAO = 500.0;
const float CORRENTE_MINIMA = 0.15;  // abaixo disso é ruído do sensor de 100 A: conta como zero

const int PINO_CORRENTE = 34;
const int PINO_TENSAO = 35;
const unsigned long JANELA_MEDICAO_MS = 200;      // 12 ciclos de 60 Hz
const unsigned long INTERVALO_ENVIO_MS = 10000;
const float VOLTS_POR_CONTAGEM = 3.3 / 4095.0;

#if USAR_HTTP
WiFiClientSecure redeSegura;
WiFiClient redeSimples;
#elif USAR_TLS
WiFiClientSecure rede;
PubSubClient mqtt(rede);
#else
WiFiClient rede;
PubSubClient mqtt(rede);
#endif

float deslocV = 2048, deslocI = 2048;  // nível médio (DC) de cada sinal, ajustado continuamente
float tensao = 0, corrente = 0, potencia = 0, fp = 0;
double energiaWh = 0;                  // acumulada desde o último envio bem-sucedido
unsigned long ultimaMedicao = 0, ultimoEnvio = 0, ultimaTentativaMqtt = 0;

void medir() {
  double somaV2 = 0, somaI2 = 0, somaVI = 0;
  unsigned long amostras = 0;
  unsigned long inicio = millis();
  while (millis() - inicio < JANELA_MEDICAO_MS) {
    float v = analogRead(PINO_TENSAO);
    float i = analogRead(PINO_CORRENTE);
    deslocV += (v - deslocV) / 1024.0;
    deslocI += (i - deslocI) / 1024.0;
    v -= deslocV;
    i -= deslocI;
    somaV2 += v * v;
    somaI2 += i * i;
    somaVI += v * i;
    amostras++;
  }
  tensao = CAL_TENSAO * VOLTS_POR_CONTAGEM * sqrt(somaV2 / amostras);
  corrente = CAL_CORRENTE * VOLTS_POR_CONTAGEM * sqrt(somaI2 / amostras);
  potencia = fabs(CAL_TENSAO * CAL_CORRENTE * VOLTS_POR_CONTAGEM * VOLTS_POR_CONTAGEM * (somaVI / amostras));
  if (corrente < CORRENTE_MINIMA) {
    corrente = 0;
    potencia = 0;
  }
  float aparente = tensao * corrente;
  fp = aparente > 0 ? min(potencia / aparente, 1.0f) : 0;

  unsigned long agora = millis();
  if (ultimaMedicao > 0) energiaWh += potencia * (agora - ultimaMedicao) / 3600000.0;
  ultimaMedicao = agora;
}

#if USAR_HTTP
void manterConexao() {}

bool publicar(const char* mensagem) {
  if (WiFi.status() != WL_CONNECTED) return false;
  String url = String(SERVIDOR_URL) + "/api/leitura/" + DISPOSITIVO_ID;
  HTTPClient http;
  http.setTimeout(15000);  // servidor grátis pode levar alguns segundos para acordar
  bool ok = url.startsWith("https") ? http.begin(redeSegura, url) : http.begin(redeSimples, url);
  if (!ok) return false;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + TOKEN_DISPOSITIVO);
  int codigo = http.POST((uint8_t*)mensagem, strlen(mensagem));
  if (codigo < 200 || codigo >= 300) Serial.printf("HTTP falhou (%d)\n", codigo);
  http.end();
  return codigo >= 200 && codigo < 300;
}
#else
void manterConexao() {
  if (WiFi.status() != WL_CONNECTED || mqtt.connected()) return;
  if (millis() - ultimaTentativaMqtt < 5000) return;
  ultimaTentativaMqtt = millis();
  String cliente = String("ampera-") + DISPOSITIVO_ID;
  if (mqtt.connect(cliente.c_str(), MQTT_USUARIO, MQTT_SENHA)) Serial.println("MQTT conectado");
  else Serial.printf("MQTT falhou (estado %d)\n", mqtt.state());
}

bool publicar(const char* mensagem) {
  char topico[80];
  snprintf(topico, sizeof(topico), "ampera/%s/leitura", DISPOSITIVO_ID);
  return mqtt.connected() && mqtt.publish(topico, mensagem);
}
#endif

void enviar() {
  char mensagem[160];
  snprintf(mensagem, sizeof(mensagem), "{\"v\":%.1f,\"i\":%.2f,\"p\":%.1f,\"fp\":%.2f,\"e_wh\":%.4f}",
           tensao, corrente, potencia, fp, energiaWh);
  Serial.println(mensagem);
  // Sem conexão, a energia continua acumulando e segue no próximo envio que der certo.
  if (publicar(mensagem)) energiaWh = 0;
}

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  analogSetPinAttenuation(PINO_CORRENTE, ADC_11db);
  analogSetPinAttenuation(PINO_TENSAO, ADC_11db);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_NOME, WIFI_SENHA);

  // Protótipo: criptografa, mas ainda não valida o certificado do servidor.
  // Para validar, troque setInsecure() por setCACert(CERTIFICADO_RAIZ).
#if USAR_HTTP
  redeSegura.setInsecure();
#else
#if USAR_TLS
  rede.setInsecure();
#endif
  mqtt.setServer(MQTT_SERVIDOR, MQTT_PORTA);
#endif

  for (int n = 0; n < 10; n++) medir();  // deixa o nível médio estabilizar antes de contar energia
  energiaWh = 0;
}

void loop() {
  medir();
  manterConexao();
#if !USAR_HTTP
  mqtt.loop();
#endif
  if (millis() - ultimoEnvio >= INTERVALO_ENVIO_MS) {
    ultimoEnvio = millis();
    enviar();
  }
}
