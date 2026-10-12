import Link from "next/link";
import { CreateCompanyForm } from "../forms";

export default function NewCompanyPage() {
  return (
    <article className="module-body">
      <div className="chat-head">
        <div>
          <h1>新建公司</h1>
          <p className="quiet">建好后可以在下面开项目。</p>
        </div>
        <Link className="ghost" href="/company">
          返回
        </Link>
      </div>
      <CreateCompanyForm />
    </article>
  );
}
