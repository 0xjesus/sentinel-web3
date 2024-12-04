import 'dotenv/config';
import {Telegraf, Markup} from 'telegraf';
import {PrismaClient} from '@prisma/client';
import puppeteer from 'puppeteer';
import cron from 'node-cron';

const prisma = new PrismaClient();
const bot = new Telegraf(process.env.BOT_TOKEN);

// Keyboard Layout
const mainKeyboard = Markup.keyboard([
	['🔍 Browse', '📋 My Tracked'],
	['🔄 Scrape Now']
]).resize();

// Commands
bot.command('start', async (ctx) => {
	try {
		await prisma.user.upsert({
			where: {id: ctx.from.id.toString()},
			update: {username: ctx.from.username},
			create: {
				id: ctx.from.id.toString(),
				username: ctx.from.username,
				firstName: ctx.from.first_name,
				lastName: ctx.from.last_name
			}
		});
		await ctx.reply('Welcome to OpportunityHunter! 🎯', mainKeyboard);
	} catch (error) {
		console.error('Start error:', error);
		await ctx.reply('Error occurred during startup.');
	}
});

/// scrap command
bot.command('scrap', async (ctx) => {
	await scrapeSuperteam(ctx);
});

// Scraping Function
async function scrapeSuperteam(ctx = null) {
	console.log('🚀 Starting enhanced Superteam scraper...');
	const browser = await puppeteer.launch({
		headless: "new",
		args: ['--no-sandbox', '--disable-setuid-sandbox'],
		defaultViewport: {width: 1920, height: 1080}
	});

	try {
		const page = await browser.newPage();

		// Increase timeouts
		page.setDefaultNavigationTimeout(120000);
		page.setDefaultTimeout(120000);

		console.log('📱 Navigating to ALL opportunities page...');
		await page.goto('https://earn.superteam.fun/all/', {
			waitUntil: 'networkidle0',
			timeout: 120000
		});

		console.log('⌛ Waiting for opportunities to load...');
		await page.waitForSelector('a[class*="block w-full rounded-md"]');

		// Scroll to load all content
		console.log('📜 Scrolling to load all content...');
		await autoScroll(page);
		let counterDebugger = 0;
		// Array to store all opportunities
		let allOpportunities = [];

		console.log('🔍 Scraping opportunities from page...');
		const opportunities = await scrapeCurrentPage(page);
		console.log(`📊 Found ${opportunities.length} initial opportunities`);
		allOpportunities.push(...opportunities);

		// Now get detailed content for each opportunity
		console.log('📖 Getting detailed content for each opportunity...');
		for (let i = 0; i < allOpportunities.length; i++) {
			const opportunity = allOpportunities[i];
			try {
				console.log(`🔄 Processing ${i + 1}/${allOpportunities.length}: ${opportunity.title}`);
				const details = await getOpportunityDetails(page, opportunity.url);
				allOpportunities[i] = {...opportunity, ...details};
				console.log(`✅ Got details for: ${opportunity.title}`);
				counterDebugger++;
			} catch (error) {
				console.error(`❌ Error getting details for ${opportunity.title}:`, error.message);
			}
			// Add small delay between requests
			await page.waitForTimeout(1000);
		}

		console.log(`✅ Successfully processed ${allOpportunities.length} opportunities`);

		if (ctx) {
			// Send in batches of 10
			for (let i = 0; i < allOpportunities.length; i += 10) {
				let message = `📊 Opportunities ${i + 1}-${Math.min(i + 10, allOpportunities.length)}:\n\n`;
				message += allOpportunities.slice(i, i + 10).map((opp, idx) =>
					`${i + idx + 1}. ${opp.title}\n` +
					`💰 ${opp.reward.amount} ${opp.reward.token}\n` +
					`⏰ ${opp.deadline}\n` +
					`📝 ${opp.type}\n` +
					`🔗 ${opp.url}\n`
				).join('\n');
				await ctx.reply(message);
				await new Promise(resolve => setTimeout(resolve, 1000));
			}
		}

		return allOpportunities;

	} catch (error) {
		console.error('❌ Scraping error:', error);
		if (ctx) {
			await ctx.reply('❌ Error during scraping: ' + error.message);
		}
		throw error;
	} finally {
		await browser.close();
		console.log('🏁 Scraper finished');
	}
}

async function autoScroll(page) {
	await page.evaluate(async () => {
		await new Promise((resolve) => {
			let totalHeight = 0;
			const distance = 100;
			const timer = setInterval(() => {
				const scrollHeight = document.documentElement.scrollHeight;
				window.scrollBy(0, distance);
				totalHeight += distance;

				if (totalHeight >= scrollHeight) {
					clearInterval(timer);
					resolve();
				}
			}, 100);
		});
	});
	await page.waitForTimeout(2000);
}

async function scrapeCurrentPage(page) {
	console.log('🔍 Starting page content extraction...');

	const opportunities = await page.evaluate(() => {
		console.log('Evaluating page content...');
		return Array.from(document.querySelectorAll('a[class*="block w-full rounded-md"]'))
			.map(item => {
				// Basic info
				const title = item.querySelector('p[class*="line-clamp-1"]')?.textContent?.trim();
				const organization = {
					name: item.querySelector('p[class*="whitespace-nowrap text-xs text-slate-500"]')?.textContent?.trim(),
					isVerified: item.querySelector('svg[class*="path fill-rule"]') !== null
				};

				// Reward details
				const rewardAmount = item.querySelector('div[class*="flex whitespace-nowrap"] span')?.textContent?.trim() ||
					item.querySelector('div[class*="flex items-baseline"] div')?.textContent?.trim();
				const rewardToken = item.querySelector('p[class*="text-xs font-medium text-gray-400"]')?.textContent?.trim();

				// Time details
				const deadline = item.querySelector('p[class*="whitespace-nowrap text-[10px] text-gray-500"]')?.textContent?.trim();

				// URL and metadata
				const url = item.href;
				const commentsCount = parseInt(item.querySelector('div[class*="items-center gap-0.5"] p')?.textContent?.trim() || '0');

				// Type and status
				const typeElement = item.querySelector('img[alt="bounty"], img[alt="project"], img[alt="grant"]');
				const type = typeElement?.getAttribute('alt') || 'unknown';
				const isFeatured = item.querySelector('div[class*="flex items-center gap-1 text-xs text-[#7C3AED]"]') !== null;
				const status = item.querySelector('div[class*="rounded-full bg-[#16A35F]"]') ? 'Open' : 'Closed';

				return {
					basicInfo: {
						title,
						organization,
						type,
						status,
						isFeatured
					},
					reward: {
						amount: rewardAmount,
						token: rewardToken,
						range: rewardAmount?.includes('-')
					},
					timing: {
						deadline,
						posted: null  // Will be extracted from detailed view
					},
					engagement: {
						commentsCount,
						url
					}
				};
			})
			.filter(item => item.basicInfo.title && item.engagement.url);
	});

	console.log(`Found ${opportunities.length} opportunities on current page`);
	return opportunities;
}

async function getOpportunityDetails(page, url) {
	console.log(`🌐 Navigating to: ${url}`);
	await page.goto(url, {
		waitUntil: 'networkidle0',
		timeout: 120000
	});

	console.log('📄 Extracting detailed content...');
	const details = await page.evaluate(() => {
		// Main content sections
		const mainContent = document.querySelector('div[class*="chakra-stack"]');
		const descriptionSection = mainContent?.querySelector('div[class*="listing-description"]');
		const requirementsSection = mainContent?.querySelector('div[class*="requirements-section"]');
		const eligibilitySection = mainContent?.querySelector('div[class*="eligibility-section"]');

		// Skills and tags
		const skills = Array.from(document.querySelectorAll('div[class*="chakra-stack"] span[class*="tag"]'))
			.map(skill => skill.textContent.trim())
			.filter(skill => skill);

		// Posted date and deadline
		const timeInfo = document.querySelector('div[class*="deadline-section"]');
		const postedDate = timeInfo?.querySelector('p:contains("Posted")')?.textContent?.replace('Posted:', '').trim();
		const deadline = timeInfo?.querySelector('p:contains("Due")')?.textContent?.replace('Due:', '').trim();

		// Reward details
		const rewardSection = document.querySelector('div[class*="reward-section"]');
		const estimatedTime = rewardSection?.querySelector('p:contains("Time")')?.textContent?.trim();
		const experience = rewardSection?.querySelector('p:contains("Experience")')?.textContent?.trim();

		// Project/Company info
		const projectInfo = {
			website: document.querySelector('a[aria-label="Website"]')?.href,
			twitter: document.querySelector('a[aria-label="Twitter"]')?.href,
			discord: document.querySelector('a[aria-label="Discord"]')?.href
		};

		return {
			detailedInfo: {
				description: descriptionSection?.textContent?.trim(),
				requirements: requirementsSection?.textContent?.trim(),
				eligibility: eligibilitySection?.textContent?.trim(),
				skills: skills,
				estimatedTime,
				experienceLevel: experience
			},
			timing: {
				postedDate,
				deadline
			},
			projectLinks: projectInfo,
			applicationProcess: {
				steps: Array.from(document.querySelectorAll('div[class*="submission-section"] li'))
					.map(step => step.textContent.trim()),
				contactInfo: document.querySelector('a[class*="chakra-link"]')?.href
			}
		};
	});

	console.log(`📊 Detail Statistics:`, {
		descriptionLength: details.detailedInfo.description?.length || 0,
		skillsCount: details.detailedInfo.skills?.length || 0,
		requirementsPresent: !!details.detailedInfo.requirements,
		hasContactInfo: !!details.applicationProcess.contactInfo
	});

	return details;
}

// Add this function to save the data as JSON
async function saveToJSON(opportunities, filename = 'superteam-opportunities.json') {
	const fs = require('fs').promises;
	try {
		await fs.writeFile(filename, JSON.stringify(opportunities, null, 2));
		console.log(`💾 Successfully saved ${opportunities.length} opportunities to ${filename}`);
	} catch (error) {
		console.error('❌ Error saving JSON:', error);
	}
}

// Manual Scraping Command
bot.hears('🔄 Scrape Now', async (ctx) => {
	await scrapeSuperteam(ctx);
});

// Browse Opportunities
bot.hears('🔍 Browse', async (ctx) => {
	try {
		const opportunities = await prisma.opportunity.findMany({
			where: {status: 'ACTIVE'},
			orderBy: {createdAt: 'desc'},
			take: 5
		});

		if (!opportunities.length) {
			return ctx.reply('No opportunities found.');
		}

		for (const opp of opportunities) {
			await ctx.reply(
				`💰 *${opp.title}*\n\n` +
				`Reward: ${opp.reward} ${opp.rewardToken}\n` +
				`Platform: ${opp.platform}\n\n` +
				`[View Details](${opp.url})`,
				{
					parse_mode: 'Markdown',
					reply_markup: {
						inline_keyboard: [[
							{text: '🎯 Track', callback_data: `track_${opp.id}`}
						]]
					}
				}
			);
		}
	} catch (error) {
		console.error('Browse error:', error);
		await ctx.reply('Error fetching opportunities.');
	}
});

// Track Opportunity
bot.action(/track_(.+)/, async (ctx) => {
	try {
		const oppId = ctx.match[1];
		await prisma.savedOpportunity.create({
			data: {
				userId: ctx.from.id.toString(),
				opportunityId: oppId,
				status: 'INTERESTED'
			}
		});
		await ctx.answerCbQuery('✅ Opportunity tracked!');
	} catch (error) {
		console.error('Track error:', error);
		await ctx.answerCbQuery('❌ Error tracking opportunity');
	}
});

// View Tracked Opportunities
bot.hears('📋 My Tracked', async (ctx) => {
	try {
		const saved = await prisma.savedOpportunity.findMany({
			where: {userId: ctx.from.id.toString()},
			include: {opportunity: true}
		});

		if (!saved.length) {
			return ctx.reply('No tracked opportunities.');
		}

		for (const item of saved) {
			await ctx.reply(
				`🎯 *${item.opportunity.title}*\n` +
				`Status: ${item.status}\n` +
				`[View Details](${item.opportunity.url})`,
				{parse_mode: 'Markdown'}
			);
		}
	} catch (error) {
		console.error('View tracked error:', error);
		await ctx.reply('Error fetching tracked opportunities.');
	}
});

// Schedule Scraping
cron.schedule('*/30 * * * *', () => scrapeSuperteam());

// Error Handler
bot.catch((error) => console.error('Bot error:', error));

// Start Bot
bot.launch()
	.then(() => console.log('🤖 Bot started'))
	.catch(error => {
		console.error('Startup error:', error);
		process.exit(1);
	});

// Graceful Shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
