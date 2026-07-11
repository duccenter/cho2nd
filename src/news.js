const Parser = require('rss-parser');
const parser = new Parser();

// RSS VNExpress
const TECH_RSS = 'https://vnexpress.net/rss/so-hoa.rss';
const FINANCE_RSS = 'https://vnexpress.net/rss/kinh-doanh.rss';

async function fetchLatestNews(rssUrl) {
    try {
        const feed = await parser.parseURL(rssUrl);
        const now = new Date();
        
        // Tìm 1 bài báo mới nhất trong vòng 24h
        for (const item of feed.items) {
            const pubDate = new Date(item.pubDate);
            const diffHours = (now - pubDate) / (1000 * 60 * 60);
            
            if (diffHours <= 24) {
                return {
                    title: item.title,
                    link: item.link,
                    date: pubDate.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' })
                };
            }
        }
        return null;
    } catch (error) {
        console.error('Lỗi lấy tin tức:', error);
        return null;
    }
}

async function getDailyNewsMessage() {
    const techNews = await fetchLatestNews(TECH_RSS);
    const financeNews = await fetchLatestNews(FINANCE_RSS);
    
    let msg = `🌅 **BẢN TIN CHỢ 2ND - ĐIỂM TIN 10H SÁNG**\n\n`;
    
    if (techNews) {
        msg += `💻 **CÔNG NGHỆ 24H QUA:**\n`;
        msg += `🔹 [${techNews.title}](${techNews.link})\n*(Cập nhật lúc ${techNews.date})*\n\n`;
    }
    
    if (financeNews) {
        msg += `📈 **THỊ TRƯỜNG - TIỀN TỆ:**\n`;
        msg += `🔹 [${financeNews.title}](${financeNews.link})\n*(Cập nhật lúc ${financeNews.date})*\n\n`;
    }
    
    if (!techNews && !financeNews) {
        return null;
    }
    
    msg += `👇 *Anh em thấy tin nào hôm nay chấn động nhất? Cùng bình luận nhé!*`;
    
    return msg;
}

module.exports = {
    getDailyNewsMessage
};
