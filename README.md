# AMPERA

Monitor de consumo de energia elétrica em tempo real para pequenos negócios.
Protótipo v1.0 · Engenharia da Computação · UNISO · 2026.

```
Sensores (SCT-013 + ZMPT101B) -> ESP32 -> MQTT -> ingestor -> PostgreSQL -> painel web
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
```

### Usar a nuvem (como no pitch)

No `.env`:

- `MQTT_URL=mqtts://SEU-CLUSTER.s1.eu.hivemq.cloud:8883` para um broker com TLS (ex.: HiveMQ Cloud, plano gratuito);
- `DATABASE_URL=postgresql://...` para um PostgreSQL hospedado (ex.: Neon ou Supabase, plano gratuito).

As tabelas são criadas na primeira execução.

## ESP32

O firmware está em `firmware/ampera_esp32/ampera_esp32.ino` (Arduino IDE, placa "ESP32 Dev Module", biblioteca PubSubClient).
Preencha no início do arquivo: Wi-Fi, endereço do broker, usuário e senha MQTT e o `DISPOSITIVO_ID`.

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
