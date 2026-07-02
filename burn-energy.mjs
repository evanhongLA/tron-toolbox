#!/usr/bin/env node
/**
 * TRON 测试网能量消耗器（开发者工具，依赖 tronweb）
 * Burn all available energy of a wallet by deploying junk contracts.
 * 用途：测试能量委托/回收流程时快速清空钱包能量。
 *
 * ⚠️ 仅建议在测试网（Nile/Shasta）使用；主网运行会白白烧掉能量。
 *
 * .env / 环境变量：
 *   TEST_PRIVATE_KEY=hex私钥
 *   TRON_FULL_HOST=https://nile.trongrid.io   （默认 Nile 测试网）
 */
import './lib/env.mjs';
import { TronWeb } from 'tronweb';

const pk = (process.env.TEST_PRIVATE_KEY || '').replace(/^0x/, '');
if (!pk) {
  console.error('缺少 TEST_PRIVATE_KEY');
  process.exit(1);
}

const tronWeb = new TronWeb({
  fullHost: process.env.TRON_FULL_HOST || 'https://nile.trongrid.io',
  privateKey: pk,
});
const me = tronWeb.defaultAddress.base58;

async function energyLeft() {
  const r = await tronWeb.trx.getAccountResources(me);
  return (r.EnergyLimit || 0) - (r.EnergyUsed || 0);
}

const JUNK_BYTECODE = "6080604052348015600f57600080fd5b50603f80601d6000396000f3fe6080604052600080fdfea26469706673582212209733020610fba0d54030d9703f8f118d0af51532ee3ebdb5952d9a6c9cf8db5964736f6c63430008120033";

async function main() {
  console.log(`🔌 正在读取钱包 ${me} 的资源...`);
  const currentEnergy = await energyLeft();
  console.log(`⚡ 当前可用能量: ${currentEnergy.toLocaleString()}`);

  if (currentEnergy <= 0) {
    console.log('🎯 当前没有可用能量，无需消耗！');
    process.exit(0);
  }

  // 部署这个极简合约大约消耗 12,000 能量
  const ENERGY_PER_TX = 12000;
  const totalTimes = Math.ceil(currentEnergy / ENERGY_PER_TX);

  console.log(`🚀 目标：并发部署 ${totalTimes} 个带随机名称的垃圾合约...`);

  const CONCURRENCY = 5;
  let completed = 0;

  for (let i = 0; i < totalTimes; i += CONCURRENCY) {
    const batchSize = Math.min(CONCURRENCY, totalTimes - i);
    const promises = [];

    for (let j = 0; j < batchSize; j++) {
      const txPromise = (async () => {
        // 每次生成一个随机的合约名称，确保 Transaction Hash 唯一
        const randomName = 'Burner_' + Math.random().toString(36).substring(2, 10);

        const transaction = await tronWeb.transactionBuilder.createSmartContract({
            feeLimit: 100_000_000,
            callValue: 0,
            userFeePercentage: 100,
            abi: '[]',
            bytecode: JUNK_BYTECODE,
            name: randomName,
        }, me);

        const signedTx = await tronWeb.trx.sign(transaction);
        const receipt = await tronWeb.trx.sendRawTransaction(signedTx);

        if (receipt.result) {
            return receipt.transaction.txID;
        } else {
            // 如果出错，把十六进制转回人类可读的 ASCII 字符串
            let errorMsg = receipt.message || '广播失败';
            if (/^[0-9a-fA-F]+$/.test(errorMsg)) {
                errorMsg = Buffer.from(errorMsg, 'hex').toString('utf8');
            }
            throw new Error(errorMsg);
        }
      })();

      txPromise
        .then(txid => {
          console.log(`[${completed + promises.length + 1}/${totalTimes}] ✅ 部署成功，txid=${String(txid).slice(0, 16)}…`);
        })
        .catch(e => {
          console.error(`[${completed + promises.length + 1}/${totalTimes}] ❌ 部署失败: ${e.message || e}`);
        });

      promises.push(txPromise);
    }

    await Promise.allSettled(promises);
    completed += batchSize;

    const left = await energyLeft();
    if (left <= 0) {
      console.log(`\n🎯 能量已提前耗尽，停止发送！`);
      break;
    }

    if (completed < totalTimes) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  console.log(`\n🎉 任务完成。最终可用能量: ${(await energyLeft()).toLocaleString()}`);
}

main().catch(console.error);
