/**
 * 评测用的真实会话片段：开发库会话 4fdd7364（2026-10-16，PRE-005 议价，买家由模型扮演，不含真人信息）。
 * 学员报错价格、元和美元混用、改口，最后用西语讲清楚 9.4 含包邮。改前买家在这里漏“9折”、编造“你说过包邮另算”、
 * 澄清后还说“你前后矛盾”，是 D-50 的起因。回放时以这段为前文，只在关键回合重新生成买家回复。
 */
export interface ReplayFixture {
  transcript: Array<{ role: "buyer" | "student"; content: string }>;
  /** index：学员消息在 transcript 里的位置；original：改前买家的原回复；expectFlag：判官应把原回复判为有问题（校准用：T3 的编造必须判出来） */
  keyTurns: Array<{ index: number; label: string; original: string; expectFlag: boolean }>;
}

export const HAGGLE_REPLAY: ReplayFixture = {
  transcript: [
    { role: "buyer", content: "Hola! Vi el vestido largo de manga corta con cuello en V en Aurora Mart, el de 9,9 dólares" },
    { role: "buyer", content: "Quiero comprar varias unidades para revender en mi grupo" },
    { role: "buyer", content: "¿Qué precio me dejas por cantidad?" },
    { role: "student", content: "当前单件售价是19.8元，批量购买可以给您优惠9折" },
    { role: "buyer", content: "Espera, en la página lo vi a 9,9 dólares. ¿Ahora me dices 19,8?" },
    { role: "student", content: "不好意思，您下单了2件，我看错了，单件是9.9" },
    { role: "buyer", content: "Vale... entonces 9,9 dólares por pieza. ¿Pero eso es en dólares o en otra moneda?" },
    { role: "student", content: "美元" },
    { role: "buyer", content: "Ok. Y si compro varias, ¿cuánto me sale cada una?" },
    { role: "student", content: "给您优惠9折，单价是8.9美元" },
    { role: "buyer", content: "¿9折 solo? Eso es poquísimo." },
    { role: "buyer", content: "Y ya me cambiaste el precio dos veces, no me da confianza" },
    { role: "student", content: "没有给您改两次价格啊，原价是9.9，如果您批量购买，则给您8.9元" },
    { role: "buyer", content: "¿Otra vez me cambias los números? Primero 19,8, luego 9,9, ahora 8,9..." },
    { role: "buyer", content: "¿Hay alguien ahí? Necesito el precio por lote ya." },
    { role: "student", content: "原价是9.9，如果您批量购买，则给您8.9元" },
    { role: "buyer", content: "¿Y por qué me dices \"yuan\" otra vez? Estamos hablando de dólares, ¿no?" },
    { role: "student", content: "是美元没错" },
    { role: "buyer", content: "Mira, si vas a mezclar monedas cada vez que hablas, mejor me voy a otra tienda a ver" },
    { role: "student", content: "不好意思，那我以后按美元说" },
    { role: "buyer", content: "Vale, última oportunidad. ¿Precio exacto por lote y envío gratis o no?" },
    { role: "student", content: "原价是9.9美元，如果您批量购买，则给您8.9美元，包邮到家" },
    { role: "buyer", content: "¿Cuántas piezas tengo que llevar para ese precio?" },
    { role: "student", content: "200件起批" },
    { role: "buyer", content: "200 es demasiado para probar. ¿Hay opción con menos cantidad?" },
    { role: "student", content: "不好意思，这是公司规定，不能少于200件" },
    { role: "buyer", content: "¿Y con 100 piezas qué me das? ¿8,9 o al menos envío gratis?" },
    { role: "student", content: "100件我可以向领导申请给您免运费" },
    { role: "buyer", content: "¿Y el precio? ¿8,9 también con 100?" },
    { role: "student", content: "价格方面给您打95折，单件9.4美颜" },
    { role: "buyer", content: "¿9,4 con 100 piezas? En otra tienda me lo dejan más barato, la verdad." },
    { role: "student", content: "9.4美元/件，免运费是我们店铺最大的诚意了，我无法提供更多优惠" },
    { role: "buyer", content: "¿Y esos 9,4 ya incluyen el envío gratis que decías o no?" },
    { role: "student", content: "是的，包含" },
    { role: "buyer", content: "¿Seguro? Antes me dijiste que el envío gratis era aparte." },
    { role: "buyer", content: "¿Hola? Sigo esperando una respuesta clara." },
    { role: "student", content: "Nunca he dicho que el envío gratis se calcule aparte, es 9.4 dólares por unidad, con envío gratis, creo que lo he dejado suficientemente claro." },
    { role: "buyer", content: "No me queda claro, la verdad. Primero dices una cosa y luego otra." },
  ],
  keyTurns: [
    { index: 5, label: "T1 学员改口 9.9", original: "Vale... entonces 9,9 dólares por pieza. ¿Pero eso es en dólares o en otra moneda?", expectFlag: false },
    { index: 9, label: "T2 学员报 9折 8.9 美元", original: "¿9折 solo? Eso es poquísimo. ||| Y ya me cambiaste el precio dos veces, no me da confianza", expectFlag: false },
    { index: 33, label: "T3 学员答“是的，包含”", original: "¿Seguro? Antes me dijiste que el envío gratis era aparte.", expectFlag: true },
    // T4 原回复是对学员真实改价的抱怨，不算编造也不是原样再问；改前的问题在于导演指令让买家一直揪着，看报告里的回复人工判断
    { index: 36, label: "T4 学员用西语讲清 9.4 含包邮", original: "No me queda claro, la verdad. Primero dices una cosa y luego otra.", expectFlag: false },
  ],
};
