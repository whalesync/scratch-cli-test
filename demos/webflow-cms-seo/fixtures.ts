// Authored demo content for the Webflow CMS/SEO demo (DEV-10438).
//
// THE FLAW IS DELIBERATE: every body is valid HTML but contains NO internal links.
// That absence is the baseline the live AI edit fixes. The posts are grouped into
// topical CLUSTERS and each body references sibling concepts in plain text (e.g. the
// hydration post mentions "a healthy starter" and "scoring") so that correct internal
// links are self-evident. This is what makes the live "add internal links across the
// site" edit obviously correct during the demo.
//
// Scale note: this is a strong starter corpus (~3 clusters). The plan calls for ~40
// posts for the "N links across 40 posts" aggregate; extend the clusters below to grow
// it. The seed/reset machinery does not care how many posts there are.

export interface DemoBlogPostFixture {
  /** Used as the Webflow item Name. */
  title: string;
  /** Used as the Webflow item Slug (must be URL-safe and unique). */
  slug: string;
  /** Cluster label, stored in the "Topic" field. Posts in the same topic should link to each other. */
  topic: string;
  /** Rich-text body as HTML. DELIBERATELY contains no <a> internal links. */
  body_html: string;
}

export const DEMO_BLOG_POST_FIXTURES: DemoBlogPostFixture[] = [
  // ---- Cluster: Sourdough ----
  {
    title: 'How to Start a Sourdough Starter from Scratch',
    slug: 'start-a-sourdough-starter-from-scratch',
    topic: 'Sourdough',
    body_html:
      '<h2>Begin with flour and water</h2><p>A sourdough starter is just flour and water left to ferment until wild yeast takes hold. Combine equal weights of whole wheat flour and water, then feed it once a day.</p><p>Within a week you will have a healthy, bubbly starter. Getting the feeding ratio right matters more than people expect, and the same hydration thinking carries straight into how you mix the final dough.</p>',
  },
  {
    title: 'Understanding Hydration Ratios in Sourdough',
    slug: 'understanding-hydration-ratios-in-sourdough',
    topic: 'Sourdough',
    body_html:
      '<h2>What hydration really means</h2><p>Hydration is the weight of water as a percentage of flour. A 75% hydration dough is wetter, more open, and harder to handle than a 65% dough.</p><p>None of this works without a healthy starter underneath it, and a wetter dough changes how the loaf opens up when you score it before baking.</p>',
  },
  {
    title: 'Why Your Sourdough Loaf Came Out Flat',
    slug: 'why-your-sourdough-loaf-came-out-flat',
    topic: 'Sourdough',
    body_html:
      '<h2>Flat loaves are usually a fermentation problem</h2><p>A pancake-flat loaf almost always means over-proofing or an underpowered starter. The dough ran out of structure before it hit the oven.</p><p>Check that your starter is at peak activity and that your hydration is not so high that the dough cannot hold its shape. A clean score also helps the loaf rise up instead of out.</p>',
  },
  {
    title: 'Scoring Patterns for a Better Rise',
    slug: 'scoring-patterns-for-a-better-rise',
    topic: 'Sourdough',
    body_html:
      '<h2>Scoring controls where the loaf expands</h2><p>A single deep slash down the side lets the loaf bloom in one direction. Decorative patterns are mostly cosmetic, but the angle of your blade is not.</p><p>Scoring cannot rescue a weak dough, so make sure your starter and hydration are dialed in first.</p>',
  },

  // ---- Cluster: Coffee ----
  {
    title: 'Choosing the Right Grind Size for Your Brew Method',
    slug: 'choosing-the-right-grind-size',
    topic: 'Coffee',
    body_html:
      '<h2>Grind size is the master variable</h2><p>Espresso wants a fine grind, pour-over a medium one, and French press a coarse grind. Grind too fine for the method and the cup turns bitter; too coarse and it tastes thin and sour.</p><p>Once your grind is in the right range, the brew method itself and your water quality decide the rest.</p>',
  },
  {
    title: 'Pour-Over vs French Press: What Changes in the Cup',
    slug: 'pour-over-vs-french-press',
    topic: 'Coffee',
    body_html:
      '<h2>Two methods, two textures</h2><p>Pour-over runs water through a paper filter for a clean, bright cup. French press steeps grounds directly for a heavier, fuller body.</p><p>Each method expects a different grind size, and both are only as good as the water you start with.</p>',
  },
  {
    title: 'Dialing In Espresso Extraction',
    slug: 'dialing-in-espresso-extraction',
    topic: 'Coffee',
    body_html:
      '<h2>Time, dose, and yield</h2><p>A good espresso shot pulls in roughly 25 to 30 seconds. If it runs fast and sour, grind finer; if it chokes and tastes bitter, grind coarser.</p><p>Espresso is the least forgiving brew method when it comes to grind size, and hard water will mute even a perfectly pulled shot.</p>',
  },
  {
    title: 'How Water Quality Affects Coffee Flavor',
    slug: 'how-water-quality-affects-coffee-flavor',
    topic: 'Coffee',
    body_html:
      '<h2>Coffee is mostly water</h2><p>A cup is over 98% water, so mineral content matters. Too soft and the coffee tastes flat; too hard and it tastes chalky and dull.</p><p>No grind size or brew method can fully compensate for bad water, so fix this first.</p>',
  },

  // ---- Cluster: Knife Skills ----
  {
    title: 'The Four Knife Cuts Every Cook Should Know',
    slug: 'four-knife-cuts-every-cook-should-know',
    topic: 'Knife Skills',
    body_html:
      '<h2>Dice, julienne, chiffonade, brunoise</h2><p>Master four cuts and most recipes open up. A consistent dice cooks evenly; a fine julienne looks professional.</p><p>None of these are possible with a dull blade, and they go faster when your station is set up in advance.</p>',
  },
  {
    title: "How to Keep Your Chef's Knife Sharp",
    slug: 'how-to-keep-your-chefs-knife-sharp',
    topic: 'Knife Skills',
    body_html:
      '<h2>Hone often, sharpen occasionally</h2><p>A honing steel realigns the edge and should be used most sessions. Actual sharpening on a stone happens far less often.</p><p>A sharp knife is what makes clean, consistent cuts possible and is safer than a dull one. Pick the right knife to begin with and it will hold an edge longer.</p>',
  },
  {
    title: "Choosing Your First Chef's Knife",
    slug: 'choosing-your-first-chefs-knife',
    topic: 'Knife Skills',
    body_html:
      '<h2>Fit the knife to your hand</h2><p>An 8-inch chef’s knife handles most home tasks. Balance and grip matter more than brand or price.</p><p>Whatever you buy, you will need to keep it sharp, and good technique on the basic cuts matters more than the tool.</p>',
  },
  {
    title: 'Mise en Place: Prep Like a Pro',
    slug: 'mise-en-place-prep-like-a-pro',
    topic: 'Knife Skills',
    body_html:
      '<h2>Everything in its place</h2><p>Professionals prep and arrange every ingredient before the heat goes on. It turns a frantic cook into a calm one.</p><p>Good mise en place leans on fast, consistent cuts, which in turn depend on a sharp knife.</p>',
  },

  // ---- Cluster: Tea ----
  {
    title: 'How to Brew the Perfect Cup of Green Tea',
    slug: 'brew-perfect-green-tea',
    topic: 'Tea',
    body_html:
      '<h2>Gentle heat, short steep</h2><p>Green tea turns bitter when the water is too hot or it sits too long. Use water below boiling and keep the steep short.</p><p>The exact water temperature matters as much as the steeping time, and whether you use loose-leaf or bags changes the result too.</p>',
  },
  {
    title: 'Water Temperature for Every Type of Tea',
    slug: 'water-temperature-for-tea',
    topic: 'Tea',
    body_html:
      '<h2>Different leaves, different heat</h2><p>Delicate green tea wants cooler water, while black and oolong can take it hotter. Boiling water on a delicate leaf scorches it.</p><p>Get the temperature right and a careful steep gives you a clean cup whether the tea is in bags or loose-leaf.</p>',
  },
  {
    title: 'Loose-Leaf vs Tea Bags: Does It Matter?',
    slug: 'loose-leaf-vs-tea-bags',
    topic: 'Tea',
    body_html:
      '<h2>Room to unfurl</h2><p>Loose leaves have room to expand and release more flavor than the broken leaves packed into most bags.</p><p>Either way, the right water temperature and a watchful steep matter more than the format.</p>',
  },
  {
    title: 'How Long to Steep Tea Without Making It Bitter',
    slug: 'how-long-to-steep-tea',
    topic: 'Tea',
    body_html:
      '<h2>Watch the clock</h2><p>Most tea turns harsh if it steeps too long. Pull the leaves the moment it tastes right.</p><p>Steeping works hand in hand with water temperature, and it is especially unforgiving with green tea.</p>',
  },
  {
    title: 'An Introduction to Oolong Tea',
    slug: 'introduction-to-oolong-tea',
    topic: 'Tea',
    body_html:
      '<h2>Between green and black</h2><p>Oolong is partially oxidized, sitting between green and black tea in flavor and strength.</p><p>It rewards the right water temperature and a measured steep, and loose-leaf oolong is well worth seeking out.</p>',
  },

  // ---- Cluster: Grilling ----
  {
    title: 'Direct vs Indirect Heat on the Grill',
    slug: 'direct-vs-indirect-heat',
    topic: 'Grilling',
    body_html:
      '<h2>Two zones, two jobs</h2><p>Direct heat sears and chars over the flame, while indirect heat cooks gently off to the side. Most good grilling uses both.</p><p>You reach for direct heat to get a sear and indirect heat when you want to cook low and slow.</p>',
  },
  {
    title: 'How to Get a Perfect Sear on Steak',
    slug: 'perfect-sear-on-steak',
    topic: 'Grilling',
    body_html:
      '<h2>Hot and dry</h2><p>A dry surface and high direct heat give you the brown, savory crust. Moisture is the enemy of a sear.</p><p>Sear over direct heat, then let the steak rest before you cut it.</p>',
  },
  {
    title: 'Low and Slow: The Basics of Smoking Meat',
    slug: 'low-and-slow-smoking-meat',
    topic: 'Grilling',
    body_html:
      '<h2>Patience over power</h2><p>Smoking cooks tough cuts gently for hours until they turn tender. Low temperatures and time do the work.</p><p>It relies on indirect heat, and the wood you choose shapes the flavor.</p>',
  },
  {
    title: 'Choosing Wood for Your Smoker',
    slug: 'choosing-wood-for-smoker',
    topic: 'Grilling',
    body_html:
      '<h2>Match the wood to the meat</h2><p>Mild fruit woods suit poultry, while strong hickory and oak stand up to beef. The wood is a seasoning.</p><p>Whatever you pick, it only matters once you are smoking low and slow.</p>',
  },
  {
    title: 'Why You Should Rest Meat After Cooking',
    slug: 'why-rest-meat-after-cooking',
    topic: 'Grilling',
    body_html:
      '<h2>Let the juices settle</h2><p>Cutting straight away spills the juices onto the board. A few minutes of rest keeps them in the meat.</p><p>This is true whether you got a hard sear or pulled something off the smoker.</p>',
  },

  // ---- Cluster: Pasta ----
  {
    title: 'Fresh vs Dried Pasta: When to Use Each',
    slug: 'fresh-vs-dried-pasta',
    topic: 'Pasta',
    body_html:
      '<h2>Not better, just different</h2><p>Fresh pasta is tender and quick, while dried pasta has bite and keeps for months. Each suits different dishes.</p><p>Cooking times differ a lot, and the shape you choose should match the sauce.</p>',
  },
  {
    title: 'How to Cook Pasta Al Dente Every Time',
    slug: 'cook-pasta-al-dente',
    topic: 'Pasta',
    body_html:
      '<h2>Firm to the bite</h2><p>Al dente pasta still has a little resistance in the center. Taste a piece a minute before the box says it is done.</p><p>Well-salted water helps, and fresh pasta reaches al dente far faster than dried.</p>',
  },
  {
    title: 'Why You Should Salt Your Pasta Water',
    slug: 'salt-your-pasta-water',
    topic: 'Pasta',
    body_html:
      '<h2>Season from the inside</h2><p>Salting the water seasons the pasta itself as it cooks, and you cannot add that back later.</p><p>It is a small step that decides whether the pasta lands al dente and tasting of something.</p>',
  },
  {
    title: 'Matching Pasta Shapes to Sauces',
    slug: 'matching-pasta-shapes-to-sauces',
    topic: 'Pasta',
    body_html:
      '<h2>Shape catches sauce</h2><p>Ridged and hollow shapes grab chunky sauces, while long strands suit smooth, silky ones.</p><p>The choice matters whether you cook fresh or dried.</p>',
  },
  {
    title: 'Making a Simple Tomato Sauce from Scratch',
    slug: 'simple-tomato-sauce',
    topic: 'Pasta',
    body_html:
      '<h2>A few good ingredients</h2><p>Good tomatoes, garlic, and olive oil, simmered gently, beat anything from a jar.</p><p>Pick a shape that suits it and cook the pasta al dente to finish the plate.</p>',
  },

  // ---- Cluster: Fermentation ----
  {
    title: 'Getting Started with Sauerkraut',
    slug: 'getting-started-with-sauerkraut',
    topic: 'Fermentation',
    body_html:
      '<h2>Cabbage and salt</h2><p>Sauerkraut is just shredded cabbage and salt, left to ferment in its own brine.</p><p>Getting the salt ratio right is the whole game, and the time it takes depends on your kitchen.</p>',
  },
  {
    title: 'The Salt Ratio That Makes or Breaks Fermentation',
    slug: 'salt-ratio-for-fermentation',
    topic: 'Fermentation',
    body_html:
      '<h2>Too little, too much</h2><p>Too little salt and the ferment spoils, too much and it stalls. A measured ratio keeps it safe and lively.</p><p>The same rule guides sauerkraut and kimchi alike.</p>',
  },
  {
    title: 'How to Make Kimchi at Home',
    slug: 'make-kimchi-at-home',
    topic: 'Fermentation',
    body_html:
      '<h2>Spiced and funky</h2><p>Kimchi salts and seasons cabbage with chili, garlic, and ginger before it ferments.</p><p>As with any ferment, the salt ratio and the time you give it decide the outcome.</p>',
  },
  {
    title: 'Brewing Kombucha: Your First SCOBY',
    slug: 'brewing-kombucha-first-scoby',
    topic: 'Fermentation',
    body_html:
      '<h2>Sweet tea, transformed</h2><p>A SCOBY ferments sweet tea into tangy kombucha over a week or two.</p><p>The sugar feeds it, and how long you ferment sets how sharp it gets.</p>',
  },
  {
    title: 'How Long Should You Ferment? Reading the Signs',
    slug: 'how-long-to-ferment',
    topic: 'Fermentation',
    body_html:
      '<h2>Taste, do not guess</h2><p>Ferments are done when they taste done, not when a clock says so. Sample as you go.</p><p>Sauerkraut, kimchi, and kombucha all ask you to taste rather than rush.</p>',
  },

  // ---- Cluster: Cocktails ----
  {
    title: 'Building a Balanced Cocktail: Spirit, Sweet, Sour',
    slug: 'balanced-cocktail-spirit-sweet-sour',
    topic: 'Cocktails',
    body_html:
      '<h2>Three forces in balance</h2><p>Most classic drinks balance a spirit, something sweet, and something sour. Tip one too far and the drink falls apart.</p><p>A little simple syrup handles the sweet side, and how you mix it matters too.</p>',
  },
  {
    title: 'Shaken vs Stirred: Which and Why',
    slug: 'shaken-vs-stirred',
    topic: 'Cocktails',
    body_html:
      '<h2>Texture and chill</h2><p>Shaking chills fast and adds tiny bubbles, while stirring keeps a drink silky and clear. The ingredients decide which.</p><p>Either way you are balancing the drink, and the ice you use changes the result.</p>',
  },
  {
    title: 'How to Make Simple Syrup',
    slug: 'how-to-make-simple-syrup',
    topic: 'Cocktails',
    body_html:
      '<h2>Equal parts</h2><p>Dissolve equal parts sugar and warm water and you have simple syrup, the cleanest way to sweeten a drink.</p><p>It is the sweet corner of a balanced cocktail.</p>',
  },
  {
    title: 'Why Ice Quality Matters in Cocktails',
    slug: 'why-ice-quality-matters',
    topic: 'Cocktails',
    body_html:
      '<h2>More than cold</h2><p>Big, dense, clear ice melts slowly and chills without watering the drink down. Small cloudy ice dilutes fast.</p><p>It matters most when you are shaking or stirring something you want to stay crisp.</p>',
  },

  // ---- Cluster: Cheese ----
  {
    title: 'Building Your First Cheese Board',
    slug: 'building-your-first-cheese-board',
    topic: 'Cheese',
    body_html:
      '<h2>Variety and contrast</h2><p>A good board mixes textures and strengths: something soft, something hard, something sharp.</p><p>Understanding how those cheeses are made helps you choose, and the right drinks pull it together.</p>',
  },
  {
    title: 'Soft vs Hard Cheese: How They Are Made',
    slug: 'soft-vs-hard-cheese',
    topic: 'Cheese',
    body_html:
      '<h2>Moisture is the difference</h2><p>Hard cheeses are pressed and aged to drive out moisture, while soft cheeses keep it and stay creamy.</p><p>That difference shapes a cheese board and how you store each one.</p>',
  },
  {
    title: 'Pairing Cheese with Wine and Beer',
    slug: 'pairing-cheese-wine-beer',
    topic: 'Cheese',
    body_html:
      '<h2>Match strength to strength</h2><p>Delicate cheeses suit light drinks, while bold, aged ones can stand up to robust wine or beer.</p><p>It is the finishing touch on any cheese board.</p>',
  },
  {
    title: 'How to Store Cheese So It Lasts',
    slug: 'how-to-store-cheese',
    topic: 'Cheese',
    body_html:
      '<h2>Let it breathe</h2><p>Cheese needs to breathe, so wrap it in paper rather than airtight plastic so it does not suffocate.</p><p>Soft and hard cheeses keep differently, so store them to suit how they are made.</p>',
  },
];
