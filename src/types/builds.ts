export interface Asset {
  browser_download_url: string;
  content_type: string;
  created_at: Date;
  digest: string;
  id: number;
  name: string;
  size: number;
  url: string;
};

export interface Build {
  id: number;
  author: string;
  tag_name: string;
  name: string;
  published_at: Date;
  assets_url: string;
  assets: Asset[];
};
