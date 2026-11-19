# AMPERA

Monitor de consumo de energia elétrica em tempo real para pequenos negócios.
Protótipo v1.0 · Engenharia da Computação · UNISO · 2026.

```
Sensores (SCT-013 + ZMPT101B) -> ESP32 -> HTTPS ou MQTT -> servidor -> PostgreSQL -> painel web
```

## O que o painel mostra

- **Tempo real**: potência, corrente, tensão e fator de potência, atualizados a cada leitura (10 s).
- **Custo em reais**: gasto de hoje, do mês até agora e **estimativa para o mês inteiro**, com a tarifa da conta de luz.
- **Histórico**: kWh, potência média, pico e custo por hora, por dia e por mês.
- **Alerta fora do horário**: registra o consumo com o negócio fechado e quanto ele custou.
- **Configurações**: tarifa, horário de funcionamento e limite do alerta por dispositivo.

## Como rodar

Requer Node.js 22 ou mais novo.

```sh
npm install
cp .env.example .env    # depois troque as senhas no .env
npm start
```

Abra http://localhost:3000 e entre com `APP_USER` / `APP_PASSWORD` do `.env`.

Sem nenhuma outra configuração, o servidor já sobe sozinho:

- um broker MQTT próprio na porta 1883 (usuário e senha `MQTT_USER` / `MQTT_PASSWORD`);
- um PostgreSQL embutido (PGlite), gravado na pasta `data/`.

### Testar sem o hardware

Com o servidor rodando, em outro terminal:

```sh
npm run simular                     # leituras ao vivo do dispositivo "simulador"
npm run simular -- --historico=7    # antes, preenche os últimos 7 dias
npm run simular -- --url=http://localhost:3000   # envia por HTTP com o DEVICE_TOKEN do .env
```

## Colocar no ar (grátis: Render + Neon, sem broker MQTT)

O servidor precisa ficar ligado o tempo todo, então **não funciona na Vercel** (funções serverless).
O site e o backend são o mesmo programa; o ESP32 envia as leituras por HTTPS direto para ele.

1. **Banco (Neon)**: crie um projeto em neon.tech e copie a connection string (`postgresql://...?sslmode=require`).
2. **Servidor (Render)**: New > Web Service > repositório `AMPERA`. Build `npm install`, Start `npm start`, plano Free.
   Variáveis de ambiente (não defina `PORT`):

   ```
   NODE_VERSION=22
   APP_USER=admin
   APP_PASSWORD=<senha do painel>
   SESSION_SECRET=<texto longo e aleatório>
   DEVICE_TOKEN=<token longo e aleatório, o mesmo do firmware>
   DATABASE_URL=<connection string do Neon>
   MQTT_ATIVO=false
   TRUST_PROXY=1
   TZ_NEGOCIO=America/Sao_Paulo
   TARIFA_PADRAO=0.85
   ```

3. **ESP32**: `USAR_HTTP 1`, `SERVIDOR_URL = "https://SEU-APP.onrender.com"` e `TOKEN_DISPOSITIVO` igual ao `DEVICE_TOKEN`.

O plano grátis do Render dorme após 15 min sem requisições; as leituras do ESP32 a cada 10 s o mantêm acordado.
Se ele estiver dormindo, o primeiro envio pode falhar enquanto o servidor acorda; a energia fica acumulada no ESP32 e vai no próximo envio.

### Envio por HTTP

`POST /api/leitura/<id-do-dispositivo>` com o cabeçalho `Authorization: Bearer <DEVICE_TOKEN>` e o mesmo JSON da mensagem MQTT (abaixo).
Responde `204` quando grava, `400` para leitura inválida, `401` para token errado e `503` se `DEVICE_TOKEN` não estiver definido.

### Usar a nuvem (como no pitch)

No `.env`:

- `MQTT_URL=mqtts://SEU-CLUSTER.s1.eu.hivemq.cloud:8883` para um broker com TLS (ex.: HiveMQ Cloud, plano gratuito);
- `DATABASE_URL=postgresql://...` para um PostgreSQL hospedado (ex.: Neon ou Supabase, plano gratuito).

As tabelas são criadas na primeira execução.

## ESP32

O firmware está em `firmware/ampera_esp32/ampera_esp32.ino` (Arduino IDE, placa "ESP32 Dev Module" com o núcleo esp32 3.x, biblioteca PubSubClient).
O certificado do servidor é validado com as autoridades certificadoras embutidas no núcleo.
Preencha no início do arquivo: Wi-Fi, `DISPOSITIVO_ID` e o modo de envio.

- HTTP(S) (`USAR_HTTP 1`, padrão): `SERVIDOR_URL` (ex.: `https://SEU-APP.onrender.com` ou `http://IP-DO-PC:3000`) e `TOKEN_DISPOSITIVO` igual ao `DEVICE_TOKEN` do servidor.
- MQTT (`USAR_HTTP 0`): endereço do broker, usuário e senha MQTT, como abaixo.

- Broker embutido: `MQTT_SERVIDOR` é o IP do computador que roda o servidor, porta 1883, `USAR_TLS 0`. O ESP32 e o computador precisam estar na mesma rede, e o firewall do Windows precisa liberar a porta 1883.
- Broker na nuvem: endereço do cluster, porta 8883, `USAR_TLS 1`.

O dispositivo aparece no painel sozinho na primeira leitura.

### Mensagem MQTT

Tópico `ampera/<id-do-dispositivo>/leitura`, JSON:

| Campo  | Significado                                                        |
| ------ | ------------------------------------------------------------------ |
| `v`    | tensão eficaz (V)                                                  |
| `i`    | corrente eficaz (A)                                                |
| `p`    | potência real (W)                                                  |
| `fp`   | fator de potência (opcional)                                       |
| `e_wh` | energia acumulada desde o último envio bem-sucedido (Wh, opcional) |
| `lote` | identificador do envio (opcional); um lote repetido é confirmado sem somar a energia de novo |

Se o Wi-Fi cair, o ESP32 continua medindo e manda a energia acumulada quando a conexão volta.

## Como o custo do mês é calculado

- Custo = kWh medidos x tarifa do dispositivo (R$ por kWh).
- Estimativa do mês = kWh já medidos + (consumo médio por hora desde a primeira leitura do mês x horas que faltam).

A estimativa só fica confiável depois de alguns dias de medição.

## Estrutura

```
src/        servidor: API, login, ingestão MQTT, banco
public/     painel web
firmware/   código do ESP32
scripts/    simulador de leituras
```
